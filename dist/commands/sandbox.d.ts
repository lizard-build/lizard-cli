import { Command } from "commander";
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
