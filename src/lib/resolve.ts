import { api, withScope, type ResourceScope } from "./api.js";
import {
  getProjectLink,
  resolveProjectId,
  updateProjectLink,
} from "./config.js";

/**
 * Build a ResourceScope for an arbitrary project. Used by resolve* helpers
 * to avoid awkward import cycles with the picker.
 */
function scopeFromLink(projectId: string): ResourceScope {
  const link = getProjectLink();
  if (link?.projectId !== projectId) return { workspaceId: null };
  return {
    workspaceId: link.workspaceId ?? null,
  };
}

interface AppLite {
  id: string;
  name: string;
  status?: string;
}

interface AddonLite {
  id: string;
  name: string;
  addonType?: string;
  status?: string;
}

interface ServicesResponse {
  apps?: AppLite[];
  addons?: AddonLite[];
}

/**
 * Resolve a service (app or addon) within a project. Match by ID or name.
 * Throws with a helpful list of available services when not found.
 */
export async function resolveService(
  projectId: string,
  nameOrId: string,
): Promise<{ id: string; name: string; kind: "app" | "addon" }> {
  const data = await api.get<ServicesResponse>(
    withScope(`/api/projects/${projectId}/services`, scopeFromLink(projectId)),
  );

  const apps = data.apps || [];
  const addons = data.addons || [];

  const lower = nameOrId.toLowerCase();

  const app = apps.find(
    (a) => a.id.toLowerCase() === lower || a.name?.toLowerCase() === lower,
  );
  if (app) return { id: app.id, name: app.name, kind: "app" };

  const addon = addons.find(
    (a) =>
      a.id.toLowerCase() === lower ||
      a.name?.toLowerCase() === lower ||
      a.addonType?.toLowerCase() === lower,
  );
  if (addon) {
    return { id: addon.id, name: addon.name || addon.addonType || "", kind: "addon" };
  }

  const available = [
    ...apps.map((a) => a.name),
    ...addons.map((a) => a.name || a.addonType),
  ].filter(Boolean);

  throw new Error(
    `Service "${nameOrId}" not found in project. ` +
      (available.length ? `Available: ${available.join(", ")}` : "No services exist."),
  );
}

/**
 * Pick the active service for a command:
 *   1. --service flag (resolve by name/id)
 *   2. linked service in cwd
 *   3. throw with hint to pass --service
 */
export async function getActiveService(
  serviceFlag: string | undefined,
  projectId: string,
): Promise<{ id: string; name: string }> {
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

  throw new Error(
    "No service specified. Pass --service <name> or run `lizard service link <name>`.",
  );
}

/**
 * Same as `getActiveService`, but also returns whether the target is an app
 * or an addon. Costs one extra `/services` lookup when the service is taken
 * from the cwd link (which otherwise resolves locally), so use this only when
 * the caller branches on kind (e.g. `lizard scale`).
 */
export async function getActiveServiceWithKind(
  serviceFlag: string | undefined,
  projectId: string,
): Promise<{ id: string; name: string; kind: "app" | "addon" }> {
  if (serviceFlag) {
    return resolveService(projectId, serviceFlag);
  }

  const link = getProjectLink();
  if (link?.serviceId) {
    const data = await api.get<ServicesResponse>(
      withScope(`/api/projects/${projectId}/services`, scopeFromLink(projectId)),
    );
    const app = data.apps?.find((a) => a.id === link.serviceId);
    if (app) return { id: app.id, name: app.name, kind: "app" };
    const addon = data.addons?.find((a) => a.id === link.serviceId);
    if (addon) {
      return {
        id: addon.id,
        name: addon.name || addon.addonType || link.serviceName || link.serviceId,
        kind: "addon",
      };
    }
    throw new Error(
      `Linked service "${link.serviceName || link.serviceId}" no longer exists in this project.`,
    );
  }

  throw new Error(
    "No service specified. Pass --service <name> or run `lizard service link <name>`.",
  );
}

/**
 * Look up the workspace id for a project. Used to lazy-fill legacy links
 * that were saved before workspaces existed. Returns null if the project
 * isn't accessible to the current user.
 */
export async function lookupProjectWorkspace(
  projectId: string,
): Promise<{ workspaceId?: string | null; workspaceName?: string | null } | null> {
  try {
    const proj = await api.get<{
      workspaceId?: string | null;
      workspaceName?: string | null;
    }>(`/api/projects/${projectId}`);
    return {
      workspaceId: proj.workspaceId ?? null,
      workspaceName: proj.workspaceName ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * Resolve a project flag → `{ projectId, scope }`. Scope carries
 * workspaceId for `withScope(url, scope)` queries.
 *
 * Lazy-fills missing workspaceId into the cwd link the same way
 * `resolveContext` does.
 */
export async function resolveProjectScope(
  projectFlag?: string,
): Promise<{ projectId: string; scope: ResourceScope }> {
  const projectId = await resolveProjectId(projectFlag);
  const link = getProjectLink();

  let workspaceId: string | null | undefined = link?.workspaceId ?? null;
  let workspaceName: string | undefined = link?.workspaceName;

  if (!workspaceId && link?.projectId === projectId) {
    const fetched = await lookupProjectWorkspace(projectId);
    if (fetched?.workspaceId) {
      workspaceId = fetched.workspaceId;
      workspaceName = fetched.workspaceName ?? undefined;
      try {
        updateProjectLink({ workspaceId, workspaceName });
      } catch {}
    }
  }

  return {
    projectId,
    scope: {
      workspaceId: workspaceId ?? null,
    },
  };
}

export interface ResolvedContext {
  projectId: string;
  workspaceId?: string;
  workspaceName?: string;
  service?: { id: string; name: string };
}

/** Build the scope object for `withScope(url, scope)` API calls. */
export function getScope(ctx: ResolvedContext): ResourceScope {
  return {
    workspaceId: ctx.workspaceId ?? null,
  };
}

/**
 * Convenience: resolve project + active service in one go.
 *
 * Lazily backfills `workspaceId` into the cwd link when missing (legacy
 * configs written before workspaces existed). Once filled, subsequent
 * commands get the scope param for free.
 */
export async function resolveContext(opts: {
  projectFlag?: string;
  serviceFlag?: string;
  workspaceFlag?: string;
  requireService?: boolean;
}): Promise<ResolvedContext> {
  const projectId = await resolveProjectId(opts.projectFlag);

  let service: { id: string; name: string } | undefined;
  const link = getProjectLink();
  if (opts.serviceFlag || opts.requireService) {
    service = await getActiveService(opts.serviceFlag, projectId);
  } else if (link?.serviceId) {
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
      } catch {
        // Non-fatal: link may not exist for this cwd (e.g. --project flag).
      }
    }
  }

  return {
    projectId,
    workspaceId,
    workspaceName,
    service,
  };
}
