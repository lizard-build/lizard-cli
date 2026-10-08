import { getToken } from "./auth.js";
import { CURRENT_VERSION } from "./updater.js";
import { detectAgent } from "./agent.js";
import * as https from "node:https";
import * as http from "node:http";
const DEFAULT_BASE_URL = "https://lizard.build";
const USER_AGENT = `lizard-cli/${CURRENT_VERSION}`;
const AGENT = detectAgent();
/**
 * Headers that say who is calling: the CLI and its version, and the coding
 * agent running it when there is one. The platform reads both to tell CLI
 * traffic from the dashboard, and agent deploys from human ones. Every
 * request to the platform sends them.
 */
export function clientHeaders() {
    return { "User-Agent": USER_AGENT, ...(AGENT ? { "X-Lizard-Agent": AGENT } : {}) };
}
let baseURL = process.env.LIZARD_API_URL || DEFAULT_BASE_URL;
let _accessToken = null;
export function setBaseURL(url) { baseURL = url; }
export function getBaseURL() { return baseURL; }
export function setAccessToken(token) { _accessToken = token; }
export function getRequestToken() { return _accessToken || getToken(); }
export function withQuery(path, params) {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
        if (value === null || value === undefined || value === "")
            continue;
        search.set(key, String(value));
    }
    const query = search.toString();
    if (!query)
        return path;
    return `${path}${path.includes("?") ? "&" : "?"}${query}`;
}
export function withScope(path, scope) {
    if (!scope)
        return path;
    return withQuery(path, {
        workspaceId: scope.workspaceId,
    });
}
export class APIError extends Error {
    status;
    code;
    body;
    constructor(status, message, code = "", body = null) {
        super(message);
        this.status = status;
        this.code = code;
        this.body = body;
    }
}
/**
 * Builds the APIError for a failed platform call from its parsed JSON body (or null).
 *
 * The platform uses two error shapes. Most routes send {error: "human text"}; the
 * billing and credits routes send {error: "SCREAMING_CODE", message: "human text"}.
 * Taking `error` unconditionally printed the bare code for the second shape and threw
 * away the sentence explaining it — so a scoped key hitting billing showed
 * "ACCOUNT_SCOPE_REQUIRED" and nothing else.
 *
 * When the body carries a link the user has to open next (Billing, the open invoice,
 * the Pro trial), the link goes on a second line of the message, so every command
 * prints it without handling the error itself.
 */
export function apiErrorFrom(status, statusText, body) {
    let msg = statusText;
    let code = "";
    if (body && typeof body === "object") {
        const j = body;
        const error = typeof j.error === "string" ? j.error : "";
        const message = typeof j.message === "string" ? j.message : "";
        const errIsCode = /^[A-Z][A-Z0-9_]*$/.test(error);
        msg = (errIsCode ? message || error : error) || message || msg;
        code = (typeof j.code === "string" && j.code) || (errIsCode ? error : "") || "";
        const next = errorLink(j);
        if (next)
            msg = `${msg}\n  ${next.label}: ${next.url}${next.hint ? ` (or run \`${next.hint}\`)` : ""}`;
    }
    return new APIError(status, msg, code, body);
}
/** Old prepaid credits (`plan: "payg"`) statuses: the next step is the Credits page. */
const CREDITS_STATUSES = new Set(["grace", "frozen", "card_required", "credits_required"]);
/**
 * True for the platform's "pay first" answer to creating anything. Servers send
 * `code: "PAYMENT_REQUIRED"`; older ones only `error: "INSUFFICIENT_CREDITS"`.
 */
export function isPaymentRequired(err) {
    if (!(err instanceof APIError))
        return false;
    return isPaymentRequiredBody(err.body);
}
function isPaymentRequiredBody(body) {
    if (!body || typeof body !== "object")
        return false;
    const j = body;
    return j.code === "PAYMENT_REQUIRED" || j.error === "INSUFFICIENT_CREDITS";
}
function httpUrl(value) {
    return typeof value === "string" && /^https?:\/\//.test(value) ? value : null;
}
/** The page an error body points to, with a label, and a CLI command that does the same. */
export function errorLink(body) {
    if (!body || typeof body !== "object")
        return null;
    const j = body;
    const invoiceUrl = httpUrl(j.invoiceUrl);
    if (invoiceUrl)
        return { label: "Pay the open invoice", url: invoiceUrl };
    const billingUrl = httpUrl(j.billingUrl);
    if (!isPaymentRequiredBody(j))
        return billingUrl ? { label: "Billing", url: billingUrl } : null;
    const subscribeUrl = httpUrl(j.subscribeUrl);
    const topupUrl = httpUrl(j.topupUrl);
    const status = typeof j.status === "string" ? j.status : "";
    if (status === "trial_available" && subscribeUrl) {
        return { label: "Start your trial", url: subscribeUrl, hint: "lizard billing start" };
    }
    if (status === "subscription_required" && subscribeUrl) {
        return { label: "Start Pro", url: subscribeUrl, hint: "lizard billing start" };
    }
    if (status === "trial_credits_used" && billingUrl) {
        return { label: "Billing", url: billingUrl, hint: "lizard billing start-now" };
    }
    if (CREDITS_STATUSES.has(status) && topupUrl)
        return { label: "Add credits", url: topupUrl };
    const url = billingUrl ?? subscribeUrl ?? topupUrl;
    return url ? { label: "Billing", url } : null;
}
export function isNotFound(err) {
    return err instanceof APIError && err.status === 404;
}
export function isAuthError(err) {
    return err instanceof APIError && (err.status === 401 || err.status === 403);
}
/**
 * True when the error is the platform's write-guard rejection for a project
 * that has been moved to trash (soft-deleted). The backend returns 409 with
 * `error: "Project is being deleted"`. We match on that signature — not on the
 * bare 409 — because `service set` also returns 409 for `configRevision`
 * optimistic-concurrency conflicts, which must stay a retryable conflict.
 */
/**
 * True when the platform refused because the calling key is scoped and the surface is
 * account-level — billing, credits, account-wide usage. A scoped key can never be "in
 * scope" for one shared balance and one set of saved cards, so this is a permanent no
 * for that key rather than something to retry.
 */
export function isAccountScopeError(err) {
    return err instanceof APIError && err.code === "ACCOUNT_SCOPE_REQUIRED";
}
export function isProjectDeletedError(err) {
    if (!(err instanceof APIError) || err.status !== 409)
        return false;
    const body = err.body;
    return body?.error === "Project is being deleted";
}
async function request(method, path, body, extraHeaders = {}) {
    const url = baseURL + path;
    const token = _accessToken || getToken();
    const headers = {
        ...clientHeaders(),
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
        let body = null;
        try {
            body = await res.json();
        }
        catch { }
        throw apiErrorFrom(res.status, res.statusText, body);
    }
    const text = await res.text();
    if (!text)
        return undefined;
    return JSON.parse(text);
}
/** Read a response as bytes, preserving binary files and text alike. */
export async function getRawBytes(path) {
    const url = baseURL + path;
    const token = _accessToken || getToken();
    const headers = clientHeaders();
    if (token)
        headers["Authorization"] = `Bearer ${token}`;
    const res = await fetch(url, { method: "GET", headers });
    if (!res.ok) {
        let body = null;
        try {
            body = await res.json();
        }
        catch { }
        throw apiErrorFrom(res.status, res.statusText, body);
    }
    return Buffer.from(await res.arrayBuffer());
}
export async function getRawText(path) {
    return (await getRawBytes(path)).toString("utf8");
}
export const api = {
    get: (path) => request("GET", path),
    post: (path, body, headers) => request("POST", path, body, headers),
    put: (path, body) => request("PUT", path, body),
    patch: (path, body) => request("PATCH", path, body),
    delete: (path, body) => request("DELETE", path, body),
};
/** Compare two Redis-stream-style event ids (`<ms>-<seq>`). Returns true when
 *  `id` is at or before `last` — i.e. a replayed event we've already shown.
 *  Ids in any other format never count as replays. */
function isReplayedId(id, last) {
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
export function streamSSE(path, handler, opts = {}) {
    return new Promise((resolve, reject) => {
        const url = new URL(baseURL + path);
        const token = _accessToken || getToken();
        const transport = url.protocol === "https:" ? https : http;
        let finished = false;
        let attempts = 0;
        let lastEventId;
        // Id of the last event handed to the handler — replay marker across reconnects.
        let lastDispatchedId;
        const settle = (err) => {
            if (finished)
                return;
            finished = true;
            if (err)
                reject(err);
            else
                resolve();
        };
        // Connection dropped without the handler asking to stop.
        const dropped = (err) => {
            if (finished)
                return;
            if (!opts.reconnect) {
                settle(err);
                return;
            }
            attempts++;
            if (attempts > MAX_RECONNECT_ATTEMPTS) {
                settle(err instanceof Error
                    ? err
                    : new Error("SSE stream disconnected and reconnect attempts failed"));
                return;
            }
            opts.onReconnect?.(attempts);
            const base = opts.reconnectBaseDelayMs ?? 1000;
            setTimeout(connect, Math.min(base * attempts, base * 5));
        };
        const connect = () => {
            if (finished)
                return;
            const reqHeaders = {
                ...clientHeaders(),
                Accept: "text/event-stream",
            };
            if (token)
                reqHeaders["Authorization"] = `Bearer ${token}`;
            if (lastEventId)
                reqHeaders["Last-Event-ID"] = lastEventId;
            const req = transport.request({ hostname: url.hostname, port: url.port || (url.protocol === "https:" ? 443 : 80),
                path: url.pathname + url.search, method: "GET", headers: reqHeaders }, (res) => {
                if (res.statusCode && res.statusCode >= 400) {
                    let body = "";
                    res.on("data", (c) => body += c.toString());
                    res.on("end", () => settle(new APIError(res.statusCode, `SSE failed: ${body}`)));
                    return;
                }
                let idleTimer;
                const finish = () => {
                    if (idleTimer)
                        clearTimeout(idleTimer);
                    finished = true;
                    req.destroy();
                    resolve();
                };
                const armIdleTimer = () => {
                    if (!opts.idleTimeoutMs)
                        return;
                    if (idleTimer)
                        clearTimeout(idleTimer);
                    idleTimer = setTimeout(finish, opts.idleTimeoutMs);
                };
                armIdleTimer();
                let buffer = "";
                let currentEvent = "";
                let currentId;
                let dataLines = [];
                res.setEncoding("utf8");
                res.on("data", (chunk) => {
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
                                const replay = opts.reconnect && currentId && lastDispatchedId
                                    ? isReplayedId(currentId, lastDispatchedId)
                                    : false;
                                if (!replay) {
                                    if (currentId)
                                        lastDispatchedId = currentId;
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
                        }
                        else if (trimmed.startsWith("event:")) {
                            currentEvent = trimmed.slice(6).trim();
                        }
                        else if (trimmed.startsWith("data:")) {
                            dataLines.push(trimmed.slice(5).trimStart());
                        }
                        else if (trimmed.startsWith("id:")) {
                            currentId = trimmed.slice(3).trim();
                            lastEventId = currentId;
                        }
                    }
                });
                res.on("end", () => {
                    if (idleTimer)
                        clearTimeout(idleTimer);
                    dropped();
                });
                res.on("error", (err) => {
                    if (idleTimer)
                        clearTimeout(idleTimer);
                    dropped(err);
                });
            });
            req.on("error", dropped);
            req.end();
        };
        connect();
    });
}
//# sourceMappingURL=api.js.map