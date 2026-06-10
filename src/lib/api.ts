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

export const api = {
  get: <T = any>(path: string) => request<T>("GET", path),
  post: <T = any>(path: string, body?: unknown, headers?: Record<string, string>) =>
    request<T>("POST", path, body, headers),
  put: <T = any>(path: string, body?: unknown) =>
    request<T>("PUT", path, body),
  patch: <T = any>(path: string, body?: unknown) =>
    request<T>("PATCH", path, body),
  delete: <T = any>(path: string) => request<T>("DELETE", path),
};

/** Stream SSE and call handler for each data line. Return false to stop.
 *
 *  `opts.idleTimeoutMs` — stop (resolve) when no *event* arrives for that
 *  long. Heartbeat comments don't reset the timer. Used by `--tail`-style
 *  snapshot reads that must not follow a live stream forever. */
export function streamSSE(
  path: string,
  handler: (event: string, data: string) => boolean | void,
  opts: { idleTimeoutMs?: number } = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const url = new URL(baseURL + path);
    const token = _accessToken || getToken();
    const reqHeaders: Record<string, string> = {
      "User-Agent": USER_AGENT,
      Accept: "text/event-stream",
    };
    if (token) reqHeaders["Authorization"] = `Bearer ${token}`;

    const transport = url.protocol === "https:" ? https : http;
    const req = transport.request(
      { hostname: url.hostname, port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname + url.search, method: "GET", headers: reqHeaders },
      (res) => {
        if (res.statusCode && res.statusCode >= 400) {
          let body = "";
          res.on("data", (c: Buffer) => body += c.toString());
          res.on("end", () => reject(new APIError(res.statusCode!, `SSE failed: ${body}`)));
          return;
        }

        let idleTimer: NodeJS.Timeout | undefined;
        const finish = () => {
          if (idleTimer) clearTimeout(idleTimer);
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
        let currentData = "";

        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          buffer += chunk;
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            const trimmed = line.replace(/\r$/, "");
            if (trimmed === "") {
              if (currentData) {
                armIdleTimer();
                const cont = handler(currentEvent, currentData);
                if (cont === false) {
                  finish();
                  return;
                }
              }
              currentEvent = "";
              currentData = "";
            } else if (trimmed.startsWith("event:")) {
              currentEvent = trimmed.slice(6).trim();
            } else if (trimmed.startsWith("data:")) {
              currentData = trimmed.slice(5).trimStart();
            }
          }
        });

        res.on("end", () => {
          if (idleTimer) clearTimeout(idleTimer);
          resolve();
        });
        res.on("error", reject);
      },
    );

    req.on("error", reject);
    req.end();
  });
}
