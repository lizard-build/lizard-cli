import { Command } from "commander";
/**
 * `lizard port [number]`
 *   bare     → show current container port
 *   <number> → update container port (takes effect on next deploy)
 */
export declare function registerPort(program: Command): void;
