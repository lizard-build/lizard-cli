import { Command } from "commander";
/**
 * `lizard port [number]`
 *   bare         → show current container port
 *   <number>     → update container port (takes effect on next deploy)
 *   0 / --worker → set worker mode (no port, no HTTP proxy)
 */
export declare function registerPort(program: Command): void;
