import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { apiErrorFrom, clientHeaders, getRequestToken, APIError } from "./api.js";

/**
 * Lizard Git (lizard.build/git) with the CLI's own sign-in: the session from `lizard login`,
 * or LIZARD_TOKEN / LIZARD_API_KEY. Lizard Git asks the platform whose it is and acts as that
 * account's user. Scoped API keys are refused there (they don't say which repositories they
 * may reach); a Lizard Git token (lzg_..., `lizard git token create`) in LIZARD_GIT_TOKEN
 * is used instead when set.
 */

export const DEFAULT_GIT_URL = "https://lizard.build/git";
/** The address before lizard.build/git: git and the API still answer there, for older clones. */
export const OLD_GIT_URL = "https://git.lizard.build";

/**
 * Where Lizard Git is. LIZARD_GIT_URL must be https (or http on this machine): the Lizard
 * sign-in goes there with every request.
 */
export function gitURL(): string {
  const u = (process.env.LIZARD_GIT_URL || DEFAULT_GIT_URL).replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(u);
  } catch {
    throw new APIError(400, `LIZARD_GIT_URL is not a URL: ${u}`);
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && local)) {
    throw new APIError(400, `LIZARD_GIT_URL must be https:// (your Lizard sign-in is sent there), got ${u}`);
  }
  return u;
}

/** The credential Lizard Git gets: LIZARD_GIT_TOKEN, else the CLI's sign-in. */
export function gitToken(): string | null {
  return process.env.LIZARD_GIT_TOKEN || getRequestToken();
}

/** One request with the Lizard Git sign-in; non-2xx answers throw. */
export function sendRaw(method: string, path: string, body?: Buffer, headers: Record<string, string> = {}): Promise<Response> {
  return send(method, path, body === undefined ? undefined : new Uint8Array(body), headers);
}

async function send(method: string, path: string, body?: BodyInit, headers: Record<string, string> = {}): Promise<Response> {
  const token = gitToken();
  const h: Record<string, string> = { ...clientHeaders(), ...headers };
  if (token) h["Authorization"] = `Bearer ${token}`;
  const res = await fetch(gitURL() + path, { method, headers: h, body });
  if (!res.ok) {
    let parsed: unknown = null;
    try {
      parsed = await res.json();
    } catch {}
    throw apiErrorFrom(res.status, res.statusText, parsed);
  }
  return res;
}

async function json<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const res = await send(method, path, body === undefined ? undefined : JSON.stringify(body),
    body === undefined ? headers : { "Content-Type": "application/json", ...headers });
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export const lg = {
  get: <T = any>(path: string) => json<T>("GET", path),
  post: <T = any>(path: string, body: unknown = {}, headers?: Record<string, string>) => json<T>("POST", path, body, headers),
  put: <T = any>(path: string, body: unknown = {}) => json<T>("PUT", path, body),
  patch: <T = any>(path: string, body: unknown) => json<T>("PATCH", path, body),
  delete: <T = any>(path: string) => json<T>("DELETE", path),
  bytes: async (path: string): Promise<Buffer> => Buffer.from(await (await send("GET", path)).arrayBuffer()),
  upload: async <T = any>(path: string, data: Buffer, contentType: string): Promise<T> =>
    (await send("POST", path, new Uint8Array(data), { "Content-Type": contentType })).json() as Promise<T>,
};

export function qs(path: string, values: Record<string, string | number | boolean | undefined | null>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(values)) if (v !== undefined && v !== null && v !== "" && v !== false) q.set(k, String(v));
  const s = q.toString();
  return s ? `${path}?${s}` : path;
}

export const seg = encodeURIComponent;
/** A branch or file path, each part escaped; . and .. parts refused (they'd reach other URLs). */
export const segs = (p: string) => {
  const parts = p.split("/");
  if (parts.some((x) => x === "" || x === "." || x === "..")) throw new APIError(400, `bad path: ${p}`);
  return parts.map(seg).join("/");
};

let me: { login: string } | null = null;
/** Your Lizard Git login. */
export async function myLogin(): Promise<string> {
  if (!me) me = await lg.get<{ login: string }>("/api/session");
  return me.login;
}

/** Every address Lizard Git has had: LIZARD_GIT_URL, or lizard.build/git and the old one. */
export function gitURLs(): string[] {
  const u = gitURL();
  return u === DEFAULT_GIT_URL ? [u, OLD_GIT_URL] : [u];
}

/** owner/name of the Lizard Git checkout this directory is in (.lizard-git/checkout.json), or null. */
function checkoutRepo(): string | null {
  for (let d = process.cwd(); ; d = dirname(d)) {
    try {
      const c = JSON.parse(readFileSync(join(d, ".lizard-git", "checkout.json"), "utf8"));
      if (typeof c.repo === "string" && /^[^/\s]+\/[^/\s]+$/.test(c.repo)) return c.repo;
    } catch {}
    if (dirname(d) === d) return null;
  }
}

/**
 * The repository a command is about: `--repo owner/name` (or just `name`: yours), else the
 * Lizard Git remote of the git checkout you're in.
 */
export async function resolveRepo(flag?: string): Promise<string> {
  if (flag) {
    const f = flag.replace(/\.git$/, "");
    const ok = (x: string) => /^[A-Za-z0-9._-]+$/.test(x) && x !== "." && x !== "..";
    if (/^[^/\s]+\/[^/\s]+$/.test(f) && f.split("/").every(ok)) return f;
    if (ok(f)) return `${await myLogin()}/${f}`;
    throw new APIError(400, `--repo is owner/name or name, got "${flag}"`);
  }
  const r = checkoutRepo();
  if (r) return r;
  throw new APIError(400, `Which repository? Pass --repo owner/name, or run this inside a checkout (lizard git clone owner/name).`);
}

export function repoPath(repo: string): string {
  const [owner, name] = repo.split("/");
  return `/api/repos/${seg(owner)}/${seg(name)}`;
}

/** Seconds (Lizard Git) to "3m ago". */
export function ago(sec: number | null | undefined): string {
  if (!sec) return "";
  const s = Math.max(0, Math.floor(Date.now() / 1000 - sec));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export const ACTIVE_RUN = new Set(["queued", "running", "waiting", "pending"]);
