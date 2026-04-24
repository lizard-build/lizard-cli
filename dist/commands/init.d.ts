import { Command } from "commander";
import { type ProjectLink } from "../lib/config.js";
/**
 * Ensure the current directory is linked to a project. If already linked and
 * `force` is false, returns the existing link. Otherwise runs the
 * create-or-select flow.
 *
 * `projectName` (from --project) takes a name: matches an existing project by
 * name/slug or creates a new one with that name.
 */
export declare function ensureLinked(opts?: {
    projectName?: string;
    force?: boolean;
    relinkPrompt?: boolean;
}): Promise<ProjectLink>;
export declare function registerInit(program: Command): void;
