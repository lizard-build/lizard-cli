import { Command } from "commander";
import { type ResourceScope } from "../lib/api.js";
export type PauseOp = "pause" | "resume";
/** The API path that pauses or resumes one service: an app, or a managed database (addon). */
export declare function servicePausePath(op: PauseOp, svc: {
    id: string;
    kind: "app" | "addon";
}, projectId: string, scope: ResourceScope): string;
/** What a project / workspace pause or resume answers. */
export type BulkPauseResult = {
    done: {
        kind: string;
        id: string;
        name: string;
    }[];
    skipped: {
        kind: string;
        id: string;
        name: string;
        reason: string;
    }[];
};
/** Human output for a project / workspace pause or resume: what was done, and what was not and why. */
export declare function printBulkResult(op: PauseOp, target: string, result: BulkPauseResult): void;
/**
 * `lizard pause [service]` / `lizard resume [service]` — stop one app or database without
 * deleting it, or start it again. Paused, it scales to 0 (an app's URL answers 503, a database
 * refuses connections) and keeps its URL, host, port, password, settings and volumes.
 */
export declare function registerPause(program: Command): void;
