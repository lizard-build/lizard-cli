import { Command } from "commander";
/**
 * `lizard service` — service group:
 *   - bare: link a service to cwd
 *   - list / link / status / delete / redeploy / restart / scale / logs
 */
export declare function registerService(program: Command): void;
