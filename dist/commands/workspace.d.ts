import { Command } from "commander";
/**
 * `lizard workspace` — create, list, and delete workspaces.
 *
 * Delete only removes empty workspaces (no projects, no sandboxes). Member
 * management (invite/remove/rename) intentionally lives in the dashboard, not
 * here, to keep the CLI surface narrow (Railway model).
 */
export declare function registerWorkspace(program: Command): void;
