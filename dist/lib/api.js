import { getToken } from "./auth.js";
const DEFAULT_BASE_URL = "https://lizard.build";
const USER_AGENT = "lizard-cli/0.1";
let baseURL = process.env.LIZARD_API_URL || DEFAULT_BASE_URL;
let _accessToken = null;
export function setBaseURL(url) { baseURL = url; }
export function getBaseURL() { return baseURL; }
export function setAccessToken(token) { _accessToken = token; }
export class APIError extends Error {
    status;
    code;
    constructor(status, message, code = "") {
        super(message);
        this.status = status;
        this.code = code;
    }
}
export function isNotFound(err) {
    return err instanceof APIError && err.status === 404;
}
export function isAuthError(err) {
    return err instanceof APIError && (err.status === 401 || err.status === 403);
}
async function request(method, path, body) {
    const url = baseURL + path;
    const token = _accessToken || getToken();
    const headers = {
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
            const j = (await res.json());
            msg = j.error || j.message || msg;
            code = j.code || "";
        }
        catch { }
        throw new APIError(res.status, msg, code);
    }
    const text = await res.text();
    if (!text)
        return undefined;
    return JSON.parse(text);
}
export const api = {
    get: (path) => request("GET", path),
    post: (path, body) => request("POST", path, body),
    put: (path, body) => request("PUT", path, body),
    patch: (path, body) => request("PATCH", path, body),
    delete: (path) => request("DELETE", path),
};
/** Stream SSE and call handler for each data line. Return false to stop. */
export async function streamSSE(path, handler) {
    const url = baseURL + path;
    const token = _accessToken || getToken();
    const headers = {
        "User-Agent": USER_AGENT,
        Accept: "text/event-stream",
    };
    if (token)
        headers["Authorization"] = `Bearer ${token}`;
    const res = await fetch(url, { headers });
    if (!res.ok) {
        throw new APIError(res.status, `SSE failed: ${res.statusText}`);
    }
    if (!res.body)
        return;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let currentEvent = "";
    let currentData = "";
    while (true) {
        const { done, value } = await reader.read();
        if (done)
            break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
            const trimmed = line.replace(/\r$/, "");
            if (trimmed === "") {
                if (currentData) {
                    const cont = handler(currentEvent, currentData);
                    if (cont === false) {
                        reader.cancel();
                        return;
                    }
                }
                currentEvent = "";
                currentData = "";
            }
            else if (trimmed.startsWith("event:")) {
                currentEvent = trimmed.slice(6).trim();
            }
            else if (trimmed.startsWith("data:")) {
                currentData = trimmed.slice(5).trimStart();
            }
        }
    }
}
//# sourceMappingURL=api.js.map