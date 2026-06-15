export declare function isTTY(): boolean;
export declare function setJSONMode(on: boolean): void;
export declare function isJSONMode(): boolean;
export declare function printJSON(data: unknown): void;
/**
 * Terminate with a stable error contract. In JSON mode emit the same
 * `{ error: { code, status, message, body } }` envelope on stdout that the
 * top-level catch in index.ts produces; otherwise print a human "Error:" line
 * on stderr. Use for validation/guard exits that would otherwise bypass the
 * envelope by calling error() + process.exit() directly, leaving agents with
 * empty stdout. `exitCode` is preserved verbatim so callers keep their
 * semantics (2 = auth, 3 = not found, 127 = command not found, …).
 */
export declare function fail(msg: string, exitCode?: number, code?: string): never;
export declare function success(msg: string): void;
export declare function error(msg: string): void;
export declare function warn(msg: string): void;
export declare function info(msg: string): void;
export declare function link(url: string, text?: string): string;
export declare function table(headers: string[], rows: string[][]): void;
export declare function statusColor(status: string): string;
export declare function timeAgo(ts: number | string): string;
