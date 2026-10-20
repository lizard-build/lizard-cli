import { Command } from "commander";
import { type ResourceScope } from "../lib/api.js";
export type SleepSetting = {
    enabled: boolean;
    idleMinutes: number;
    lastSleptAt: number | null;
    lastWokeAt: number | null;
    lastError: string | null;
    sleeps: number;
    wakes: number;
    restarted?: boolean;
};
/** The API path of a service's serverless setting: an app, or a managed database (addon). */
export declare function sleepPath(svc: {
    id: string;
    kind: "app" | "addon";
}, projectId: string, scope: ResourceScope): string;
/** The body of a change, from --on / --off / --idle; null when only reading. */
export declare function sleepChange(opts: {
    on?: boolean;
    off?: boolean;
    idle?: number;
}, current?: SleepSetting): {
    enabled: boolean;
    idleMinutes?: number;
} | null;
/**
 * `lizard sleep [service]` (alias `serverless`) — serverless, i.e. sleep when idle: with no
 * traffic for the idle time the service sleeps with its memory saved, and the next request or
 * connection wakes it in about a second. Apps with one replica and a port; Postgres and Redis.
 *   no flag   show the setting
 *   --on      turn it on (restarts the service once); --idle <minutes> 5-1440
 *   --off     always on
 */
export declare function registerSleep(program: Command): void;
