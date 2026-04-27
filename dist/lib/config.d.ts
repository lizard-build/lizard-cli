export interface Credentials {
    accessToken: string;
    refreshToken?: string;
    expiresAt?: string;
    userId: string;
    username: string;
    email?: string;
    avatarUrl?: string;
}
export interface ProjectLink {
    projectId: string;
    projectName?: string;
    /** Active environment for this cwd */
    environmentId?: string;
    environmentName?: string;
    /** Active service for this cwd. `appId/appName` are kept as aliases for backwards compat. */
    serviceId?: string;
    serviceName?: string;
    /** @deprecated use serviceId */
    appId?: string;
    /** @deprecated use serviceName */
    appName?: string;
}
export interface Config {
    credentials?: Credentials;
    projects?: Record<string, ProjectLink>;
}
export declare function loadConfig(): Config;
export declare function saveConfig(config: Config): void;
/**
 * Read the link for a directory. Normalises legacy `appId/appName` into
 * `serviceId/serviceName` so callers only have to look at one pair.
 */
export declare function getProjectLink(cwd?: string): ProjectLink | null;
export declare function setProjectLink(link: ProjectLink, cwd?: string): void;
export declare function updateProjectLink(patch: Partial<ProjectLink>, cwd?: string): void;
export declare function clearProjectLink(cwd?: string): void;
/**
 * Resolve projectId from: --project flag (ID only) → linked cwd → error.
 * For name-based resolution, callers should look up the project list first.
 */
export declare function resolveProjectId(flagValue?: string): string;
