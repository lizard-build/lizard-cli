export declare const CURRENT_VERSION = "0.2.3";
export declare function getLatestVersion(): Promise<string | null>;
export declare function selfUpdate(onProgress?: (msg: string) => void): Promise<boolean>;
/** Run silently in background — checks for update and prints a notice after command finishes. */
export declare function checkForUpdateInBackground(): void;
