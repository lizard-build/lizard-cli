import { Command } from "commander";
/**
 * When the sandbox goes away. The platform deletes it, files and all, once its
 * lifetime runs out, and the default is five minutes, so say it up front.
 */
export declare function lifetimeLine(expiresAt: number | string | null | undefined, now?: number): string;
/** What to do with a sandbox you just made, as aligned lines with its id filled in. */
export declare function sandboxNextSteps(id: string): string;
export declare function registerSandbox(program: Command): void;
/** A file up to this size goes in one request. The server takes ~150 MB per request and the
 *  content travels as base64 (4/3 of the bytes), so a single request stops at ~110 MB. */
export declare const PUT_SINGLE_MAX: number;
/** A bigger file goes in pieces of this size, joined inside the sandbox. */
export declare const PUT_CHUNK: number;
/**
 * Write a local file into a sandbox; resolves with its size. Over PUT_SINGLE_MAX the file is
 * read and sent one piece at a time (memory stays at one piece): each piece is written next to
 * the destination, appended to a temporary file and removed, and the temporary file is renamed
 * onto the destination at the end, so a failed upload never leaves a half-written file there
 * and the sandbox's disk needs the file plus one piece.
 */
export declare function putSandboxFile(id: string, local: string, remote: string, chunk?: number, singleMax?: number): Promise<number>;
/** Run a command inside a sandbox, streaming output. Resolves with the exit
 *  code: the remote command's code from the `exit` event, or 1 when the
 *  server reported an `error` event without one. Mirrors ssh.ts's parser. */
export declare function execStream(sandboxId: string, cmd: string, onLine: (stream: string, line: string) => void): Promise<number>;
/** Parse `WxH` (e.g. 1920x1080) and check the bounds the server enforces, so a typo
 *  fails before a round trip that would start the desktop at the wrong size. */
export declare function parseResolution(value: string): {
    width: number;
    height: number;
};
