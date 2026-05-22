import { api, withScope } from "./api.js";
import { getProjectLink, resolveProjectId, updateProjectLink, } from "./config.js";
/**
 * Build a ResourceScope for an arbitrary project. Used by resolve* helpers
 * to avoid awkward import cycles with the picker.
 */
function scopeFromLink(projectId) {
    const link = getProjectLink();
    if (link?.projectId !== projectId)
        return { workspaceId: null, environmentName: null };
    return {
        workspaceId: link.workspaceId ?? null,
        environmentName: link.environmentName ?? null,
    };
}
/**
 * Resolve a service (app or addon) within a project. Match by ID or name.
 * Throws with a helpful list of available services when not found.
 */
export async function resolveService(projectId, nameOrId) {
    const data = await api.get(withScope(`/api/projects/${projectId}/services`, scopeFromLink(projectId)));
    const apps = data.apps || [];
    const addons = data.addons || [];
    const lower = nameOrId.toLowerCase();
    const app = apps.find((a) => a.id.toLowerCase() === lower || a.name?.toLowerCase() === lower);
    if (app)
        return { id: app.id, name: app.name, kind: "app" };
    const addon = addons.find((a) => a.id.toLowerCase() === lower ||
        a.name?.toLowerCase() === lower ||
        a.addonType?.toLowerCase() === lower);
    if (addon) {
        return { id: addon.id, name: addon.name || addon.addonType || "", kind: "addon" };
    }
    const available = [
        ...apps.map((a) => a.name),
        ...addons.map((a) => a.name || a.addonType),
    ].filter(Boolean);
    throw new Error(`Service "${nameOrId}" not found in project. ` +
        (available.length ? `Available: ${available.join(", ")}` : "No services exist."));
}
/**
 * Pick the active service for a command:
 *   1. --service flag (resolve by name/id)
 *   2. linked service in cwd
 *   3. throw with hint to pass --service
 */
export async function getActiveService(serviceFlag, projectId) {
    if (serviceFlag) {
        const resolved = await resolveService(projectId, serviceFlag);
        return { id: resolved.id, name: resolved.name };
    }
    const link = getProjectLink();
    if (link?.serviceId) {
        return {
            id: link.serviceId,
            name: link.serviceName || link.serviceId,
        };
    }
    throw new Error("No service specified. Pass --service <name> or run `lizard service link <name>`.");
}
/**
 * Same as `getActiveService`, but also returns whether the target is an app
 * or an addon. Costs one extra `/services` lookup when the service is taken
 * from the cwd link (which otherwise resolves locally), so use this only when
 * the caller branches on kind (e.g. `lizard scale`).
 */
export async function getActiveServiceWithKind(serviceFlag, projectId) {
    if (serviceFlag) {
        return resolveService(projectId, serviceFlag);
    }
    const link = getProjectLink();
    if (link?.serviceId) {
        const data = await api.get(withScope(`/api/projects/${projectId}/services`, scopeFromLink(projectId)));
        const app = data.apps?.find((a) => a.id === link.serviceId);
        if (app)
            return { id: app.id, name: app.name, kind: "app" };
        const addon = data.addons?.find((a) => a.id === link.serviceId);
        if (addon) {
            return {
                id: addon.id,
                name: addon.name || addon.addonType || link.serviceName || link.serviceId,
                kind: "addon",
            };
        }
        throw new Error(`Linked service "${link.serviceName || link.serviceId}" no longer exists in this project.`);
    }
    throw new Error("No service specified. Pass --service <name> or run `lizard service link <name>`.");
}
/**
 * Resolve an environment within a project. Match by ID or name. If the API
 * does not have environments yet, returns null silently.
 */
export async function resolveEnvironment(projectId, nameOrId) {
    let envs = [];
    try {
        envs = await api.get(withScope(`/api/projects/${projectId}/environments`, scopeFromLink(projectId)));
    }
    catch {
        return null;
    }
    if (!envs?.length)
        return null;
    if (nameOrId) {
        const lower = nameOrId.toLowerCase();
        const match = envs.find((e) => e.id.toLowerCase() === lower || e.name.toLowerCase() === lower);
        if (!match) {
            throw new Error(`Environment "${nameOrId}" not found. Available: ${envs.map((e) => e.name).join(", ")}`);
        }
        return match;
    }
    const link = getProjectLink();
    if (link?.environmentId) {
        return {
            id: link.environmentId,
            name: link.environmentName || link.environmentId,
        };
    }
    // Default: first env (typically "production")
    return envs[0];
}
/**
 * Look up the workspace id for a project. Used to lazy-fill legacy links
 * that were saved before workspaces existed. Returns null if the project
 * isn't accessible to the current user.
 */
export async function lookupProjectWorkspace(projectId) {
    try {
        const proj = await api.get(`/api/projects/${projectId}`);
        return {
            workspaceId: proj.workspaceId ?? null,
            workspaceName: proj.workspaceName ?? null,
        };
    }
    catch {
        return null;
    }
}
/**
 * Resolve a project flag → `{ projectId, scope }`. Scope carries
 * workspaceId + environmentName for `withScope(url, scope)` queries.
 *
 * Lazy-fills missing workspaceId into the cwd link the same way
 * `resolveContext` does.
 */
export async function resolveProjectScope(projectFlag) {
    const projectId = await resolveProjectId(projectFlag);
    const link = getProjectLink();
    let workspaceId = link?.workspaceId ?? null;
    let workspaceName = link?.workspaceName;
    if (!workspaceId && link?.projectId === projectId) {
        const fetched = await lookupProjectWorkspace(projectId);
        if (fetched?.workspaceId) {
            workspaceId = fetched.workspaceId;
            workspaceName = fetched.workspaceName ?? undefined;
            try {
                updateProjectLink({ workspaceId, workspaceName });
            }
            catch { }
        }
    }
    return {
        projectId,
        scope: {
            workspaceId: workspaceId ?? null,
            environmentName: link?.environmentName ?? null,
        },
    };
}
/** Build the scope object for `withScope(url, scope)` API calls. */
export function getScope(ctx) {
    return {
        workspaceId: ctx.workspaceId ?? null,
        environmentName: ctx.environment?.name ?? null,
    };
}
/**
 * Convenience: resolve project + active service + active environment in one go.
 *
 * Lazily backfills `workspaceId` into the cwd link when missing (legacy
 * configs written before workspaces existed). Once filled, subsequent
 * commands get the scope param for free.
 */
export async function resolveContext(opts) {
    const projectId = await resolveProjectId(opts.projectFlag);
    const environment = await resolveEnvironment(projectId, opts.environmentFlag).catch(() => null);
    let service;
    const link = getProjectLink();
    if (opts.serviceFlag || opts.requireService) {
        service = await getActiveService(opts.serviceFlag, projectId);
    }
    else if (link?.serviceId) {
        service = {
            id: link.serviceId,
            name: link.serviceName || link.serviceId,
        };
    }
    // Workspace resolution: prefer the link (no extra API call), fall back to
    // a one-shot lookup which we cache back into the link.
    let workspaceId = link?.workspaceId;
    let workspaceName = link?.workspaceName;
    if (!workspaceId && link?.projectId === projectId) {
        const fetched = await lookupProjectWorkspace(projectId);
        if (fetched?.workspaceId) {
            workspaceId = fetched.workspaceId;
            workspaceName = fetched.workspaceName ?? undefined;
            try {
                updateProjectLink({
                    workspaceId,
                    workspaceName,
                });
            }
            catch {
                // Non-fatal: link may not exist for this cwd (e.g. --project flag).
            }
        }
    }
    return {
        projectId,
        workspaceId,
        workspaceName,
        service,
        environment: environment || undefined,
    };
}
//# sourceMappingURL=resolve.js.map