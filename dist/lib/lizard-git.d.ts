/**
 * Lizard Git (lizard.build/git) with the CLI's own sign-in: the session from `lizard login`,
 * or LIZARD_TOKEN / LIZARD_API_KEY. Lizard Git asks the platform whose it is and acts as that
 * account's user. Scoped API keys are refused there (they don't say which repositories they
 * may reach); a Lizard Git token (lzg_..., `lizard git token create`) in LIZARD_GIT_TOKEN
 * is used instead when set.
 */
export declare const DEFAULT_GIT_URL = "https://lizard.build/git";
/** The address before lizard.build/git: git and the API still answer there, for older clones. */
export declare const OLD_GIT_URL = "https://git.lizard.build";
/**
 * Where Lizard Git is. LIZARD_GIT_URL must be https (or http on this machine): the Lizard
 * sign-in goes there with every request.
 */
export declare function gitURL(): string;
/** The credential Lizard Git gets: LIZARD_GIT_TOKEN, else the CLI's sign-in. */
export declare function gitToken(): string | null;
export declare const lg: {
    get: <T = any>(path: string) => Promise<T>;
    post: <T = any>(path: string, body?: unknown, headers?: Record<string, string>) => Promise<T>;
    put: <T = any>(path: string, body?: unknown) => Promise<T>;
    patch: <T = any>(path: string, body: unknown) => Promise<T>;
    delete: <T = any>(path: string) => Promise<T>;
    bytes: (path: string) => Promise<Buffer>;
    upload: <T = any>(path: string, data: Buffer, contentType: string) => Promise<T>;
};
export declare function qs(path: string, values: Record<string, string | number | boolean | undefined | null>): string;
export declare const seg: typeof encodeURIComponent;
/** A branch or file path, each part escaped; . and .. parts refused (they'd reach other URLs). */
export declare const segs: (p: string) => string;
/** Your Lizard Git login. */
export declare function myLogin(): Promise<string>;
/** owner/name from a Lizard Git remote URL (https or ssh-style), or null. */
/** Every address a Lizard Git remote may use: LIZARD_GIT_URL, or lizard.build/git and the old one. */
export declare function gitURLs(): string[];
export declare function repoFromRemote(url: string, bases?: string[]): string | null;
/**
 * The repository a command is about: `--repo owner/name` (or just `name`: yours), else the
 * Lizard Git remote of the git checkout you're in.
 */
export declare function resolveRepo(flag?: string): Promise<string>;
export declare function repoPath(repo: string): string;
export declare function cloneURL(repo: string): string;
/** How git should run this CLI as its credential helper. */
export declare function helperCommand(): string;
/** Seconds (Lizard Git) to "3m ago". */
export declare function ago(sec: number | null | undefined): string;
export declare const ACTIVE_RUN: Set<string>;
