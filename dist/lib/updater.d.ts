export declare const CURRENT_VERSION = "0.2.56";
export type LatestVersionResult = {
    kind: "ok";
    version: string;
} | {
    kind: "rate-limited";
    resetAt: number;
} | {
    kind: "error";
};
export declare function getLatestVersion(): Promise<LatestVersionResult>;
export declare function selfUpdate(onProgress?: (msg: string) => void): Promise<boolean>;
/** Run silently in background — checks for update and prints a notice after command finishes. */
export declare function checkForUpdateInBackground(): void;
