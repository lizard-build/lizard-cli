import { Command } from "commander";
/**
 * `lizard service show` — print the current service configuration as JSON.
 *
 * Useful for diff-ing against a `lizard.config.json`, seeding a new file,
 * or feeding into `lizard service set` to roll back.
 *
 * Without `-s` shows the whole project (all services keyed by ID).
 * With `-s <name>` shows just that service.
 */
export declare function registerServiceShow(svc: Command): void;
