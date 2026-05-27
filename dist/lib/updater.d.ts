export declare const CURRENT_VERSION = "0.3.19";
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
/** Check for a newer version and auto-install it in the background.
 *  Prints a one-line notice on exit — either "Updated to vX.Y.Z" or nothing on failure.
 *  Never blocks or crashes the current command. */
export declare function checkForUpdateInBackground(): void;
