import { Command } from "commander";
export declare function registerSandbox(program: Command): void;
/** Parse `WxH` (e.g. 1920x1080) and check the bounds the server enforces, so a typo
 *  fails before a round trip that would start the desktop at the wrong size. */
export declare function parseResolution(value: string): {
    width: number;
    height: number;
};
