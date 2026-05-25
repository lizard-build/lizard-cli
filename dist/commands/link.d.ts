import { Command } from "commander";
/**
 * `lizard link` — associates the current directory with an existing
 * project + environment + (optional) service. Each piece can be passed
 * via flags or selected interactively.
 *
 * Order matches Railway's wizard: workspace → project → environment → service.
 */
export declare function registerLink(program: Command): void;
