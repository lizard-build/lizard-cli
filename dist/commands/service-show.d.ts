import { Command } from "commander";
/**
 * `lizard service show` — print the current service configuration as JSON.
 *
 * Works for both apps and addons. Without `-s` shows the whole project
 * (`{ apps, addons }`). With `-s <name>` shows just that service.
 *
 * Useful for diff-ing against a `lizard.config.json`, seeding a new file,
 * or feeding into `lizard service set` to roll back.
 */
export declare function registerServiceShow(svc: Command): void;
