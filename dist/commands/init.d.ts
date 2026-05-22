import { Command } from "commander";
import { type Workspace } from "../lib/api.js";
import { type ProjectLink } from "../lib/config.js";
/**
 * Ensure the current directory is linked to a project. If already linked and
 * `force` is false, returns the existing link. Otherwise runs the
 * create-or-select flow.
 *
 * Flow (mirrors Railway's `link` wizard):
 *   1. Workspace — selected by --workspace, single workspace auto-pick,
 *      or interactive select. Skipped when only one workspace exists.
 *   2. Project — matched by --name within the workspace, picked from the
 *      workspace's project list, or created.
 *
 * `projectName` (from --name / --project) is matched against existing
 * projects inside the resolved workspace; if not found, a new project
 * with that name is created in the resolved workspace.
 */
export declare function ensureLinked(opts?: {
    projectName?: string;
    workspaceFlag?: string;
    force?: boolean;
    relinkPrompt?: boolean;
}): Promise<ProjectLink>;
export declare function registerInit(program: Command): void;
export type { Workspace };
