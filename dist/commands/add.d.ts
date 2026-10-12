import { Command } from "commander";
/**
 * Resolve a project by name/slug/id. Name-based lookup hits /api/projects and
 * matches against the list. Falls back to the cwd-linked project when no
 * -p/--project is supplied.
 *
 * When `workspaceFlag` is provided, the lookup is constrained to that
 * workspace — useful for disambiguating identically-named projects.
 */
export declare function resolveProject(flagValue: string | undefined, workspaceFlag?: string): Promise<string>;
export declare function registerAdd(program: Command): void;
