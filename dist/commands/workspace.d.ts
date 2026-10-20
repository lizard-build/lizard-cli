import { Command } from "commander";
export declare const RESALE_FIELDS: readonly [{
    readonly key: "cpu";
    readonly flag: "cpu";
    readonly label: "CPU";
}, {
    readonly key: "memory";
    readonly flag: "memory";
    readonly label: "Memory";
}, {
    readonly key: "storage";
    readonly flag: "storage";
    readonly label: "Volumes";
}, {
    readonly key: "egress";
    readonly flag: "egress";
    readonly label: "Egress";
}, {
    readonly key: "objectStorage";
    readonly flag: "objectStorage";
    readonly label: "Object storage";
}, {
    readonly key: "sandbox";
    readonly flag: "sandbox";
    readonly label: "Sandboxes";
}];
export type ResaleMultipliers = Record<(typeof RESALE_FIELDS)[number]["key"], number>;
export type ResalePricing = {
    enabled: boolean;
    multipliers: ResaleMultipliers;
};
/**
 * The multipliers to save: the current ones with the given flags changed (`--all` first,
 * then each resource flag). Null when no flag was given (show only).
 */
export declare function mergeResale(current: ResaleMultipliers, opts: Partial<Record<(typeof RESALE_FIELDS)[number]["flag"] | "all", string>>): ResaleMultipliers | null;
export type WorkspaceLimits = {
    maxRunningSandboxes: number | null;
    maxCpuVcpus: number | null;
    maxMemoryMb: number | null;
    maxDiskGb?: number | null;
};
export type WorkspaceUsage = {
    runningSandboxes: number;
    cpuVcpus: number;
    memoryMb: number;
    diskGb?: number;
    measuredAt: number | null;
};
/** "4GB", "512mb", "2048" (MB) or "none" -> MB, or null for no limit. */
export declare function parseMemoryLimit(raw: string): number | null;
/** "20GB", "500MB", "1TB", "50" (GB) or "none" -> GB, or null for no limit. */
export declare function parseDiskLimit(raw: string): number | null;
/** The body for PUT /limits from the flags given; null when none was given (show only). */
export declare function limitsBody(opts: {
    sandboxes?: string;
    cpu?: string;
    memory?: string;
    disk?: string;
}): Partial<WorkspaceLimits> | null;
/**
 * `lizard workspace` — create, list, and delete workspaces.
 *
 * Delete only removes empty workspaces (no projects, no sandboxes). `resale-pricing` sets the
 * prices a workspace's scoped keys are shown (a reseller's users). Member
 * management (invite/remove/rename) intentionally lives in the dashboard, not
 * here, to keep the CLI surface narrow (Railway model).
 */
export declare function registerWorkspace(program: Command): void;
