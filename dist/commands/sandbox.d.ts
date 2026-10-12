import { Command } from "commander";
/**
 * When the sandbox goes away. The platform deletes it, files and all, once its
 * lifetime runs out, and the default is five minutes, so say it up front.
 */
export declare function lifetimeLine(expiresAt: number | string | null | undefined, now?: number): string;
/** What to do with a sandbox you just made, as aligned lines with its id filled in. */
export declare function sandboxNextSteps(id: string): string;
export declare function registerSandbox(program: Command): void;
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
