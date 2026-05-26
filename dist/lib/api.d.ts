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
export declare const api: {
    get: <T = any>(path: string) => Promise<T>;
    post: <T = any>(path: string, body?: unknown, headers?: Record<string, string>) => Promise<T>;
    put: <T = any>(path: string, body?: unknown) => Promise<T>;
    patch: <T = any>(path: string, body?: unknown) => Promise<T>;
    delete: <T = any>(path: string) => Promise<T>;
};
/** Stream SSE and call handler for each data line. Return false to stop. */
export declare function streamSSE(path: string, handler: (event: string, data: string) => boolean | void): Promise<void>;
