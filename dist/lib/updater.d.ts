export declare const CURRENT_VERSION = "0.3.38";
/**
 * True only when running as the Bun-compiled standalone binary. Under
 * npm/node, `process.execPath` is the *node* executable — self-update would
 * overwrite the user's Node.js install with the lizard binary.
 */
export declare function isStandaloneBinary(): boolean;
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
export declare function isNewerVersion(latest: string, current: string): boolean;
export declare function selfUpdate(onProgress?: (msg: string) => void): Promise<boolean>;
/**
 * Kick off an update check without delaying the current command.
 *
 * The check+download runs in a *detached child process* (`lizard
 * __lizard-update`): an in-process fetch would keep the event loop alive and
 * make every command linger until GitHub answers. Checks are throttled via a
 * stamp file (6h), disabled with LIZARD_NO_UPDATE/CI, and only run for the
 * standalone binary — npm installs upgrade through npm.
 */
export declare function checkForUpdateInBackground(): void;
/**
 * Body of the hidden `__lizard-update` command: check the latest release and
 * install it, leaving a notice file for the next foreground run.
 */
export declare function runBackgroundUpdate(): Promise<void>;
