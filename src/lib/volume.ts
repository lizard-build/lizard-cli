import { api, withScope, type ResourceScope } from "./api.js";

export interface VolumeRecord {
  id: string;
  name: string;
  sizeGb: number;
  status: string;
  attachedTo?: string | null;
  createdAt?: number;
}

/**
 * A volume's name is its key inside a project (LIZARD-161), so it has to be a shape
 * that survives a URL, a mount path and a shell argument. Validated here as well as
 * on the server so a typo is reported before the request goes out.
 */
export const VOLUME_NAME_RE = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/;

export function assertValidVolumeName(name: string): void {
  if (VOLUME_NAME_RE.test(name)) return;
  throw new Error(
    `Invalid volume name "${name}". Use lowercase letters, digits and dashes, ` +
      `starting and ending with a letter or digit (max 64 chars) — e.g. "build-cache".`,
  );
}

/**
 * Resolve a volume by name or ID through the server.
 *
 * This used to be a client-side `.find()` over the project's volume list, duplicated
 * in `volume.ts` and `sandbox.ts`. Nothing enforced name uniqueness back then, so with
 * duplicates present it silently picked whichever row came back first — you asked for
 * your volume and mounted someone else's. The server now resolves a name itself and
 * names are unique per project.
 *
 * The list fallback is only for talking to a server older than that change; it refuses
 * to guess when a name is ambiguous rather than repeating the original bug.
 */
export async function resolveVolume(
  projectId: string,
  scope: ResourceScope,
  nameOrId: string,
): Promise<VolumeRecord> {
  try {
    return await api.get<VolumeRecord>(
      withScope(`/api/projects/${projectId}/volumes/${encodeURIComponent(nameOrId)}`, scope),
    );
  } catch (e: any) {
    if (e?.status && e.status !== 404) throw e;
  }

  const volumes = await api.get<VolumeRecord[]>(
    withScope(`/api/projects/${projectId}/volumes`, scope),
  );
  const lower = nameOrId.toLowerCase();
  const matches = volumes.filter(
    (v) => v.id.toLowerCase() === lower || v.name.toLowerCase() === lower,
  );
  if (matches.length > 1) {
    throw new Error(
      `Volume "${nameOrId}" is ambiguous — ${matches.length} volumes in this project share that name ` +
        `(${matches.map((v) => v.id).join(", ")}). Delete the duplicates, or pass the ID you want.`,
    );
  }
  if (matches.length === 0) {
    throw new Error(
      `Volume "${nameOrId}" not found. Available: ${volumes.map((v) => v.name).join(", ") || "(none)"}`,
    );
  }
  return matches[0];
}
