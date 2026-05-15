import { Command } from "commander";
/**
 * `lizard down` — stops the latest deployment of a service.
 * The service itself is preserved; use `lizard service rm` to delete it.
 */
export declare function registerDown(program: Command): void;
