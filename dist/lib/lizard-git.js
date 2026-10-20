import { execFileSync } from "node:child_process";
import { apiErrorFrom, clientHeaders, getRequestToken, APIError } from "./api.js";
/**
 * Lizard Git (git.lizard.build) with the CLI's own sign-in: the session from `lizard login`,
 * or LIZARD_TOKEN / LIZARD_API_KEY. Lizard Git asks the platform whose it is and acts as that
 * account's user. Scoped API keys are refused there (they don't say which repositories they
 * may reach); a Lizard Git token (lzg_..., `lizard git token create`) in LIZARD_GIT_TOKEN
 * is used instead when set.
 */
export const DEFAULT_GIT_URL = "https://git.lizard.build";
export function gitURL() {
    return (process.env.LIZARD_GIT_URL || DEFAULT_GIT_URL).replace(/\/+$/, "");
}
/** The credential Lizard Git gets: LIZARD_GIT_TOKEN, else the CLI's sign-in. */
export function gitToken() {
    return process.env.LIZARD_GIT_TOKEN || getRequestToken();
}
async function send(method, path, body, headers = {}) {
    const token = gitToken();
    const h = { ...clientHeaders(), ...headers };
    if (token)
        h["Authorization"] = `Bearer ${token}`;
    const res = await fetch(gitURL() + path, { method, headers: h, body });
    if (!res.ok) {
        let parsed = null;
        try {
            parsed = await res.json();
        }
        catch { }
        throw apiErrorFrom(res.status, res.statusText, parsed);
    }
    return res;
}
async function json(method, path, body, headers = {}) {
    const res = await send(method, path, body === undefined ? undefined : JSON.stringify(body), body === undefined ? headers : { "Content-Type": "application/json", ...headers });
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined);
}
export const lg = {
    get: (path) => json("GET", path),
    post: (path, body = {}, headers) => json("POST", path, body, headers),
    put: (path, body = {}) => json("PUT", path, body),
    patch: (path, body) => json("PATCH", path, body),
    delete: (path) => json("DELETE", path),
    bytes: async (path) => Buffer.from(await (await send("GET", path)).arrayBuffer()),
    upload: async (path, data, contentType) => (await send("POST", path, new Uint8Array(data), { "Content-Type": contentType })).json(),
};
export function qs(path, values) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(values))
        if (v !== undefined && v !== null && v !== "" && v !== false)
            q.set(k, String(v));
    const s = q.toString();
    return s ? `${path}?${s}` : path;
}
export const seg = encodeURIComponent;
export const segs = (p) => p.split("/").map(seg).join("/");
let me = null;
/** Your Lizard Git login. */
export async function myLogin() {
    if (!me)
        me = await lg.get("/api/session");
    return me.login;
}
/** owner/name from a Lizard Git remote URL (https or ssh-style), or null. */
export function repoFromRemote(url, base = gitURL()) {
    const host = new URL(base).host;
    const m = url.trim().match(/^(?:https?:\/\/)(?:[^@/]+@)?([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
    if (!m || m[1] !== host)
        return null;
    return `${m[2]}/${m[3]}`;
}
function originRepo() {
    try {
        const remotes = execFileSync("git", ["remote", "-v"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
        const lines = remotes.split("\n").filter((l) => l.includes("(fetch)"));
        const ordered = [...lines.filter((l) => l.startsWith("origin\t")), ...lines];
        for (const l of ordered) {
            const r = repoFromRemote(l.split(/\s+/)[1] ?? "");
            if (r)
                return r;
        }
    }
    catch { }
    return null;
}
/**
 * The repository a command is about: `--repo owner/name` (or just `name`: yours), else the
 * Lizard Git remote of the git checkout you're in.
 */
export async function resolveRepo(flag) {
    if (flag) {
        const f = flag.replace(/\.git$/, "");
        if (/^[^/\s]+\/[^/\s]+$/.test(f))
            return f;
        if (/^[^/\s]+$/.test(f))
            return `${await myLogin()}/${f}`;
        throw new APIError(400, `--repo is owner/name or name, got "${flag}"`);
    }
    const r = originRepo();
    if (r)
        return r;
    throw new APIError(400, `Which repository? Pass --repo owner/name, or run this inside a clone of a Lizard Git repository (${gitURL()}).`);
}
export function repoPath(repo) {
    const [owner, name] = repo.split("/");
    return `/api/repos/${seg(owner)}/${seg(name)}`;
}
export function cloneURL(repo) {
    return `${gitURL()}/${repo}.git`;
}
/** How git should run this CLI as its credential helper. */
export function helperCommand() {
    const script = process.argv[1] ?? "";
    const q = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
    // npm install: node + the script. Standalone binary: the binary itself.
    if (/\.(c|m)?js$/.test(script))
        return `!${q(process.execPath)} ${q(script)} git credential`;
    return `!${q(process.execPath)} git credential`;
}
/** Seconds (Lizard Git) to "3m ago". */
export function ago(sec) {
    if (!sec)
        return "";
    const s = Math.max(0, Math.floor(Date.now() / 1000 - sec));
    if (s < 60)
        return `${s}s ago`;
    if (s < 3600)
        return `${Math.floor(s / 60)}m ago`;
    if (s < 86400)
        return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
}
export const ACTIVE_RUN = new Set(["queued", "running", "waiting", "pending"]);
//# sourceMappingURL=lizard-git.js.map