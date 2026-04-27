/**
 * Resolve a service (app or addon) within a project. Match by ID or name.
 * Throws with a helpful list of available services when not found.
 */
export declare function resolveService(projectId: string, nameOrId: string): Promise<{
    id: string;
    name: string;
    kind: "app" | "addon";
}>;
/**
 * Pick the active service for a command:
 *   1. --service flag (resolve by name/id)
 *   2. linked service in cwd
 *   3. throw with hint to pass --service
 */
export declare function getActiveService(serviceFlag: string | undefined, projectId: string): Promise<{
    id: string;
    name: string;
}>;
/**
 * Resolve an environment within a project. Match by ID or name. If the API
 * does not have environments yet, returns null silently.
 */
export declare function resolveEnvironment(projectId: string, nameOrId: string | undefined): Promise<{
    id: string;
    name: string;
} | null>;
/**
 * Convenience: resolve project + active service + active environment in one go.
 */
export declare function resolveContext(opts: {
    projectFlag?: string;
    serviceFlag?: string;
    environmentFlag?: string;
    requireService?: boolean;
}): Promise<{
    projectId: string;
    service?: {
        id: string;
        name: string;
    };
    environment?: {
        id: string;
        name: string;
    };
}>;
