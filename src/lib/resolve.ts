import { api } from "./api.js";
import { getProjectLink, resolveProjectId } from "./config.js";

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

interface EnvironmentLite {
  id: string;
  name: string;
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
    `/api/projects/${projectId}/services`,
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
 * Resolve an environment within a project. Match by ID or name. If the API
 * does not have environments yet, returns null silently.
 */
export async function resolveEnvironment(
  projectId: string,
  nameOrId: string | undefined,
): Promise<{ id: string; name: string } | null> {
  let envs: EnvironmentLite[] = [];
  try {
    envs = await api.get<EnvironmentLite[]>(
      `/api/projects/${projectId}/environments`,
    );
  } catch {
    return null;
  }

  if (!envs?.length) return null;

  if (nameOrId) {
    const lower = nameOrId.toLowerCase();
    const match = envs.find(
      (e) => e.id.toLowerCase() === lower || e.name.toLowerCase() === lower,
    );
    if (!match) {
      throw new Error(
        `Environment "${nameOrId}" not found. Available: ${envs.map((e) => e.name).join(", ")}`,
      );
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
 * Convenience: resolve project + active service + active environment in one go.
 */
export async function resolveContext(opts: {
  projectFlag?: string;
  serviceFlag?: string;
  environmentFlag?: string;
  requireService?: boolean;
}): Promise<{
  projectId: string;
  service?: { id: string; name: string };
  environment?: { id: string; name: string };
}> {
  const projectId = resolveProjectId(opts.projectFlag);

  const environment = await resolveEnvironment(
    projectId,
    opts.environmentFlag,
  ).catch(() => null);

  let service: { id: string; name: string } | undefined;
  if (opts.serviceFlag || opts.requireService) {
    service = await getActiveService(opts.serviceFlag, projectId);
  } else {
    const link = getProjectLink();
    if (link?.serviceId) {
      service = {
        id: link.serviceId,
        name: link.serviceName || link.serviceId,
      };
    }
  }

  return { projectId, service, environment: environment || undefined };
}
