import { Command } from "commander";
/** Inline `<!-- include: _shared/x.md -->` lines, as scripts/gen-skills.mjs does for the embedded copy. */
export declare function expandIncludes(md: string, root: string): string;
export declare function registerSkill(program: Command): void;
