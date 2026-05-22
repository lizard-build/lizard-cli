import { Command } from "commander";
/**
 * `lizard workspace` — workspace info.
 *
 * Member management (invite/remove/rename) intentionally lives in the
 * dashboard, not here, to keep CLI surface narrow (Railway model).
 */
export declare function registerWorkspace(program: Command): void;
