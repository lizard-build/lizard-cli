import { Command } from "commander";
/**
 * `lizard fn`: Lizard Functions (AWS Lambda-compatible) from the CLI, made for one-command
 * use by people and agents: `lizard fn deploy handler.py --packages requests --url`
 * creates or updates the function, installs its packages (kept in a layer: unchanged ones
 * are not reinstalled), waits until it is ready and prints how to call it.
 * Everything goes through the platform as the logged-in user (no AWS keys needed);
 * `lizard fn env` prints keys for the AWS SDKs / CLI when code needs them.
 */
export type Lang = "python" | "node" | "ruby" | "go" | "rust" | "shell";
export declare const DEFAULT_RUNTIME: Record<Lang, string>;
export interface Source {
    lang: Lang;
    files: {
        name: string;
        data: Buffer;
        mode?: number;
    }[];
    handler: string;
    entry: string;
    deps: boolean;
}
/** What a file or directory is: language, files to send, handler, and whether it has a dependency file. */
export declare function detectSource(p: string, opts?: {
    runtime?: string;
    handler?: string;
    stdinName?: string;
    stdin?: string;
}): Source;
/** The handler (module.function) from the source, as Lambda names it. */
export declare function findHandler(lang: Lang, entry: string, text: string): string;
export declare function zipFiles(files: Source["files"]): Buffer;
export declare function registerFn(program: Command): void;
