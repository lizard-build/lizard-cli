import { Command } from "commander";
/**
 * `lizard link` — associates the current directory with an existing
 * project and (optionally) service. Each piece can be passed via flags
 * or selected interactively.
 *
 * Order matches Railway's wizard: workspace → project → service.
 */
export declare function registerLink(program: Command): void;
