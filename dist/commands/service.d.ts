import { Command } from "commander";
/**
 * `lizard service` — service group:
 *   - bare: link a service to cwd
 *   - list / link / status / delete / redeploy / restart / logs
 *   (scaling lives on the top-level `lizard scale` command)
 */
export declare function registerService(program: Command): void;
