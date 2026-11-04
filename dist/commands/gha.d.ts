import { Command } from "commander";
/** owner/name from a GitHub remote URL (https, ssh or git@), or null. */
export declare function repoFromRemote(url: string): string | null;
export declare function registerGha(program: Command): void;
