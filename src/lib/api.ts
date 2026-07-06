import { getToken } from "./auth.js";
import { CURRENT_VERSION } from "./updater.js";
import * as https from "node:https";
import * as http from "node:http";

const DEFAULT_BASE_URL = "https://lizard.build";
const USER_AGENT = `lizard-cli/${CURRENT_VERSION}`;

let baseURL = process.env.LIZARD_API_URL || DEFAULT_BASE_URL;
let _accessToken: string | null = null;

export function setBaseURL(url: string) { baseURL = url; }
export function getBaseURL() { return baseURL; }
export function setAccessToken(token: string) { _accessToken = token; }

// ── Scoping ───────────────────────────────────────────────────────────
//
// Every project-scoped endpoint takes `?workspaceId=…` — mirrors
// lizard-client's `withScope` so server-side state is shared across
// CLI and browser. Build URLs through these helpers, never by hand.

export interface ResourceScope {
  workspaceId?: string | null;
}

export interface Workspace {
  id: string;
  name: string;
  slug: string;
  role: "owner" | "member";
  isPersonal?: boolean;
  projectCount?: number;
  createdAt?: number;
}

export function withQuery(
  path: string,
  params: Record<string, string | number | boolean | null | undefined>,
): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === "") continue;
    search.set(key, String(value));
  }
  const query = search.toString();
  if (!query) return path;
  return `${path}${path.includes("?") ? "&" : "?"}${query}`;
}

export function withScope(path: string, scope?: ResourceScope): string {
  if (!scope) return path;
  return withQuery(path, {
    workspaceId: scope.workspaceId,
  });
}

export class APIError extends Error {
  status: number;
  code: string;
  body: unknown;
  constructor(status: number, message: string, code = "", body: unknown = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

export function isNotFound(err: unknown): boolean {
  return err instanceof APIError && err.status === 404;
}

export function isAuthError(err: unknown): boolean {
  return err instanceof APIError && (err.status === 401 || err.status === 403);
}

/**
 * True when the error is the platform's write-guard rejection for a project
 * that has been moved to trash (soft-deleted). The backend returns 409 with
 * `error: "Project is being deleted"`. We match on that signature — not on the
 * bare 409 — because `service set` also returns 409 for `configRevision`
 * optimistic-concurrency conflicts, which must stay a retryable conflict.
 */
export function isProjectDeletedError(err: unknown): err is APIError {
  if (!(err instanceof APIError) || err.status !== 409) return false;
  const body = err.body as { error?: string } | null;
  return body?.error === "Project is being deleted";
}

async function request<T = any>(
  method: string,
  path: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<T> {
  const url = baseURL + path;
  const token = _accessToken || getToken();

  const headers: Record<string, string> = {
    "User-Agent": USER_AGENT,
    ...extraHeaders,
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    let msg = res.statusText;
    let code = "";
    let body: unknown = null;
    try {
      const j = (await res.json()) as any;
      body = j;
      msg = j.error || j.message || msg;
      code = j.code || "";
    } catch {}
    throw new APIError(res.status, msg, code, body);
  }

  const text = await res.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

/** Like api.get, but returns the raw response body instead of JSON.parse-ing
 *  it — for endpoints that reply with `text/plain` (e.g. sandbox file reads). */
export async function getRawText(path: string): Promise<string> {
  const url = baseURL + path;
  const token = _accessToken || getToken();
  const headers: Record<string, string> = { "User-Agent": USER_AGENT };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(url, { method: "GET", headers });
  if (!res.ok) {
    let msg = res.statusText;
    let code = "";
    let body: unknown = null;
    try {
      const j = (await res.json()) as any;
      body = j;
      msg = j.error || j.message || msg;
      code = j.code || "";
    } catch {}
    throw new APIError(res.status, msg, code, body);
  }
  return res.text();
}

export const api = {
  get: <T = any>(path: string) => request<T>("GET", path),
  post: <T = any>(path: string, body?: unknown, headers?: Record<string, string>) =>
    request<T>("POST", path, body, headers),
  put: <T = any>(path: string, body?: unknown) =>
    request<T>("PUT", path, body),
  patch: <T = any>(path: string, body?: unknown) =>
    request<T>("PATCH", path, body),
  delete: <T = any>(path: string, body?: unknown) => request<T>("DELETE", path, body),
};

/** Compare two Redis-stream-style event ids (`<ms>-<seq>`). Returns true when
 *  `id` is at or before `last` — i.e. a replayed event we've already shown.
 *  Ids in any other format never count as replays. */
function isReplayedId(id: string, last: string): boolean {
  const a = id.split("-").map(Number);
  const b = last.split("-").map(Number);
  if (a.length !== 2 || b.length !== 2 || a.some(Number.isNaN) || b.some(Number.isNaN)) {
    return false;
  }
  return a[0] < b[0] || (a[0] === b[0] && a[1] <= b[1]);
}

const MAX_RECONNECT_ATTEMPTS = 5;

/** Stream SSE and call handler for each event. Return false to stop.
 *
 *  `opts.idleTimeoutMs` — stop (resolve) when no *event* arrives for that
 *  long. Heartbeat comments don't reset the timer. Used by `--tail`-style
 *  snapshot reads that must not follow a live stream forever.
 *
 *  `opts.reconnect` — re-establish the connection when the server drops it
 *  (API deploys, proxy idle timeouts). Resumes via `Last-Event-ID` and
 *  suppresses events the server replays from before the drop. Rejects after
 *  MAX_RECONNECT_ATTEMPTS consecutive failures so callers exit non-zero
 *  instead of pretending the stream ended cleanly. `opts.onReconnect` fires
 *  before each attempt. */
export function streamSSE(
  path: string,
  handler: (event: string, data: string) => boolean | void,
  opts: {
    idleTimeoutMs?: number;
    reconnect?: boolean;
    onReconnect?: (attempt: number) => void;
    /** Base backoff between reconnect attempts; scaled by attempt number. */
    reconnectBaseDelayMs?: number;
  } = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const url = new URL(baseURL + path);
    const token = _accessToken || getToken();
    const transport = url.protocol === "https:" ? https : http;

    let finished = false;
    let attempts = 0;
    let lastEventId: string | undefined;
    // Id of the last event handed to the handler — replay marker across reconnects.
    let lastDispatchedId: string | undefined;

    const settle = (err?: unknown) => {
      if (finished) return;
      finished = true;
      if (err) reject(err);
      else resolve();
    };

    // Connection dropped without the handler asking to stop.
    const dropped = (err?: unknown) => {
      if (finished) return;
      if (!opts.reconnect) {
        settle(err);
        return;
      }
      attempts++;
      if (attempts > MAX_RECONNECT_ATTEMPTS) {
        settle(
          err instanceof Error
            ? err
            : new Error("SSE stream disconnected and reconnect attempts failed"),
        );
        return;
      }
      opts.onReconnect?.(attempts);
      const base = opts.reconnectBaseDelayMs ?? 1000;
      setTimeout(connect, Math.min(base * attempts, base * 5));
    };

    const connect = () => {
      if (finished) return;
      const reqHeaders: Record<string, string> = {
        "User-Agent": USER_AGENT,
        Accept: "text/event-stream",
      };
      if (token) reqHeaders["Authorization"] = `Bearer ${token}`;
      if (lastEventId) reqHeaders["Last-Event-ID"] = lastEventId;

      const req = transport.request(
        { hostname: url.hostname, port: url.port || (url.protocol === "https:" ? 443 : 80),
          path: url.pathname + url.search, method: "GET", headers: reqHeaders },
        (res) => {
          if (res.statusCode && res.statusCode >= 400) {
            let body = "";
            res.on("data", (c: Buffer) => body += c.toString());
            res.on("end", () => settle(new APIError(res.statusCode!, `SSE failed: ${body}`)));
            return;
          }

          let idleTimer: NodeJS.Timeout | undefined;
          const finish = () => {
            if (idleTimer) clearTimeout(idleTimer);
            finished = true;
            req.destroy();
            resolve();
          };
          const armIdleTimer = () => {
            if (!opts.idleTimeoutMs) return;
            if (idleTimer) clearTimeout(idleTimer);
            idleTimer = setTimeout(finish, opts.idleTimeoutMs);
          };
          armIdleTimer();

          let buffer = "";
          let currentEvent = "";
          let currentId: string | undefined;
          let dataLines: string[] = [];

          res.setEncoding("utf8");
          res.on("data", (chunk: string) => {
            buffer += chunk;
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";

            for (const line of lines) {
              const trimmed = line.replace(/\r$/, "");
              if (trimmed === "") {
                const data = dataLines.join("\n");
                if (data) {
                  attempts = 0; // stream is healthy — reset the reconnect budget
                  armIdleTimer();
                  // After a reconnect the app-log endpoint replays recent
                  // history; skip entries we already printed.
                  const replay =
                    opts.reconnect && currentId && lastDispatchedId
                      ? isReplayedId(currentId, lastDispatchedId)
                      : false;
                  if (!replay) {
                    if (currentId) lastDispatchedId = currentId;
                    const cont = handler(currentEvent, data);
                    if (cont === false) {
                      finish();
                      return;
                    }
                  }
                }
                currentEvent = "";
                currentId = undefined;
                dataLines = [];
              } else if (trimmed.startsWith("event:")) {
                currentEvent = trimmed.slice(6).trim();
              } else if (trimmed.startsWith("data:")) {
                dataLines.push(trimmed.slice(5).trimStart());
              } else if (trimmed.startsWith("id:")) {
                currentId = trimmed.slice(3).trim();
                lastEventId = currentId;
              }
            }
          });

          res.on("end", () => {
            if (idleTimer) clearTimeout(idleTimer);
            dropped();
          });
          res.on("error", (err) => {
            if (idleTimer) clearTimeout(idleTimer);
            dropped(err);
          });
        },
      );

      req.on("error", dropped);
      req.end();
    };

    connect();
  });
}
