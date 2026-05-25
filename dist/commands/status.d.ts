import { Command } from "commander";
/**
 * `lizard status` — print the linked workspace / project / environment /
 * service for the current working directory. Mirrors `railway status`.
 *
 * Lazy-fills workspaceId into the link when missing so legacy configs
 * surface their workspace too.
 */
export declare function registerStatus(program: Command): void;
