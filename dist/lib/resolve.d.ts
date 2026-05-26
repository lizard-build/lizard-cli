import { type ResourceScope } from "./api.js";
/**
 * Build a ResourceScope for an arbitrary project. When the project matches the
 * cwd link, reuse its workspaceId (no extra round-trip). Otherwise fetch the
 * project's workspace once so cross-project commands (`-p other-project`) still
 * get `?workspaceId=…` on the request — without it the backend can 404 a
 * project the user reaches via workspace membership.
 */
export declare function scopeForProject(projectId: string): Promise<ResourceScope>;
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
 * Same as `getActiveService`, but also returns whether the target is an app
 * or an addon. Costs one extra `/services` lookup when the service is taken
 * from the cwd link (which otherwise resolves locally), so use this only when
 * the caller branches on kind (e.g. `lizard scale`).
 */
export declare function getActiveServiceWithKind(serviceFlag: string | undefined, projectId: string): Promise<{
    id: string;
    name: string;
    kind: "app" | "addon";
}>;
/**
 * Look up the workspace id for a project. Used to lazy-fill legacy links
 * that were saved before workspaces existed. Returns null if the project
 * isn't accessible to the current user.
 */
export declare function lookupProjectWorkspace(projectId: string): Promise<{
    workspaceId?: string | null;
    workspaceName?: string | null;
} | null>;
/**
 * Resolve a project flag → `{ projectId, scope }`. Scope carries
 * workspaceId for `withScope(url, scope)` queries.
 *
 * For the linked project, lazy-fills missing workspaceId into the cwd link.
 * For a different project (`-p other-project`), fetches the target's
 * workspace so the scope reflects the target — not whatever the cwd link
 * happened to be pointing at.
 */
export declare function resolveProjectScope(projectFlag?: string): Promise<{
    projectId: string;
    scope: ResourceScope;
}>;
export interface ResolvedContext {
    projectId: string;
    workspaceId?: string;
    workspaceName?: string;
    service?: {
        id: string;
        name: string;
    };
}
/** Build the scope object for `withScope(url, scope)` API calls. */
export declare function getScope(ctx: ResolvedContext): ResourceScope;
/**
 * Convenience: resolve project + active service in one go.
 *
 * Lazily backfills `workspaceId` into the cwd link when missing (legacy
 * configs written before workspaces existed). Once filled, subsequent
 * commands get the scope param for free.
 */
export declare function resolveContext(opts: {
    projectFlag?: string;
    serviceFlag?: string;
    workspaceFlag?: string;
    requireService?: boolean;
}): Promise<ResolvedContext>;
