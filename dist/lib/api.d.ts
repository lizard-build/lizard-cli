export declare function setBaseURL(url: string): void;
export declare function getBaseURL(): string;
export declare function setAccessToken(token: string): void;
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
export declare function withQuery(path: string, params: Record<string, string | number | boolean | null | undefined>): string;
export declare function withScope(path: string, scope?: ResourceScope): string;
export declare class APIError extends Error {
    status: number;
    code: string;
    body: unknown;
    constructor(status: number, message: string, code?: string, body?: unknown);
}
export declare function isNotFound(err: unknown): boolean;
export declare function isAuthError(err: unknown): boolean;
/**
 * True when the error is the platform's write-guard rejection for a project
 * that has been moved to trash (soft-deleted). The backend returns 409 with
 * `error: "Project is being deleted"`. We match on that signature — not on the
 * bare 409 — because `service set` also returns 409 for `configRevision`
 * optimistic-concurrency conflicts, which must stay a retryable conflict.
 */
export declare function isProjectDeletedError(err: unknown): err is APIError;
/** Like api.get, but returns the raw response body instead of JSON.parse-ing
 *  it — for endpoints that reply with `text/plain` (e.g. sandbox file reads). */
export declare function getRawText(path: string): Promise<string>;
export declare const api: {
    get: <T = any>(path: string) => Promise<T>;
    post: <T = any>(path: string, body?: unknown, headers?: Record<string, string>) => Promise<T>;
    put: <T = any>(path: string, body?: unknown) => Promise<T>;
    patch: <T = any>(path: string, body?: unknown) => Promise<T>;
    delete: <T = any>(path: string, body?: unknown) => Promise<T>;
};
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
export declare function streamSSE(path: string, handler: (event: string, data: string) => boolean | void, opts?: {
    idleTimeoutMs?: number;
    reconnect?: boolean;
    onReconnect?: (attempt: number) => void;
    /** Base backoff between reconnect attempts; scaled by attempt number. */
    reconnectBaseDelayMs?: number;
}): Promise<void>;
