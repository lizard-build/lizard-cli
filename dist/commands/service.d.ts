import { Command } from "commander";
/**
 * `lizard service` — service group:
 *   - bare: link a service to cwd
 *   - list / link / status / delete / rename / set / show / logs
 *   (scale / redeploy / restart live on the top-level commands of the same name)
 */
export declare function registerService(program: Command): void;
