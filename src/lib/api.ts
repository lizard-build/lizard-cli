import { getToken } from "./auth.js";
import * as https from "node:https";
import * as http from "node:http";

const DEFAULT_BASE_URL = "https://lizard.build";
const USER_AGENT = "lizard-cli/0.1";

let baseURL = process.env.LIZARD_API_URL || DEFAULT_BASE_URL;
let _accessToken: string | null = null;

export function setBaseURL(url: string) { baseURL = url; }
export function getBaseURL() { return baseURL; }
export function setAccessToken(token: string) { _accessToken = token; }

export class APIError extends Error {
  status: number;
  code: string;
  constructor(status: number, message: string, code = "") {
    super(message);
    this.status = status;
    this.code = code;
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
): Promise<T> {
  const url = baseURL + path;
  const token = _accessToken || getToken();

  const headers: Record<string, string> = {
    "User-Agent": USER_AGENT,
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
    try {
      const j = (await res.json()) as any;
      msg = j.error || j.message || msg;
      code = j.code || "";
    } catch {}
    throw new APIError(res.status, msg, code);
  }

  const text = await res.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

export const api = {
  get: <T = any>(path: string) => request<T>("GET", path),
  post: <T = any>(path: string, body?: unknown) =>
    request<T>("POST", path, body),
  put: <T = any>(path: string, body?: unknown) =>
    request<T>("PUT", path, body),
  patch: <T = any>(path: string, body?: unknown) =>
    request<T>("PATCH", path, body),
  delete: <T = any>(path: string) => request<T>("DELETE", path),
};

/** Stream SSE and call handler for each data line. Return false to stop. */
export function streamSSE(
  path: string,
  handler: (event: string, data: string) => boolean | void,
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
                const cont = handler(currentEvent, currentData);
                if (cont === false) {
                  req.destroy();
                  resolve();
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

        res.on("end", resolve);
        res.on("error", reject);
      },
    );

    req.on("error", reject);
    req.end();
  });
}
