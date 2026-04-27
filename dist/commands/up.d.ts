import { Command } from "commander";
/**
 * Builds the `up` command. Mirrors `railway up`:
 *   - upload local code (or `[path]`) as a tarball
 *   - target a service via --service / linked / first-in-project
 *   - --ci streams build logs only and exits when build finishes
 *   - --detach returns immediately after upload
 */
export declare function registerUp(program: Command): void;
