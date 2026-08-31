import { Command } from "commander";
/**
 * `lizard keys` — create, list, and delete API keys.
 *
 * A key with no scope has full access. `--project` / `--workspace` (both
 * repeatable) restrict it, matching the dashboard's scoping.
 */
export declare function registerKeys(program: Command): void;
