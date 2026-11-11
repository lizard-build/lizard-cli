import { Command } from "commander";
import { type ResourceScope } from "../lib/api.js";
/**
 * Builds the `up` command:
 *   - upload local code (or `[path]`) as a tarball
 *   - target a service via --service / linked / first-in-project
 *   - --ci streams build logs only and exits when build finishes
 *   - --detach returns immediately after upload
 */
export declare function registerUp(program: Command): void;
export declare function deployFromLocal(args: {
    projectId: string;
    scope: ResourceScope;
    targetPath: string;
    buildCommand?: string;
    startCommand?: string;
    preDeployCommand?: string;
    port?: number;
    useGitignore: boolean;
    serviceFlag: string | undefined;
    existingServiceId: string | undefined;
    region: string | undefined;
    opts: any;
}): Promise<void>;
export declare function streamBuildLogs(appId: string, ciMode?: boolean, knownBuildId?: string): Promise<void>;
