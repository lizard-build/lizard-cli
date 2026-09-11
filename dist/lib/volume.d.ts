import { type ResourceScope } from "./api.js";
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
export declare const VOLUME_NAME_RE: RegExp;
export declare function assertValidVolumeName(name: string): void;
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
export declare function resolveVolume(projectId: string, scope: ResourceScope, nameOrId: string): Promise<VolumeRecord>;
