export declare const DEFAULT_REGION = "us-east-1";
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
    /** Workspace the project belongs to. Lazy-filled for legacy links. */
    workspaceId?: string;
    workspaceName?: string;
    /** Active service for this cwd. `appId/appName` are kept as aliases for backwards compat. */
    serviceId?: string;
    serviceName?: string;
    /** @deprecated use serviceId */
    appId?: string;
    /** @deprecated use serviceName */
    appName?: string;
}
export interface PendingAuth {
    sessionId: string;
    sessionSecret: string;
    authUrl: string;
    createdAt: number;
}
export interface Config {
    credentials?: Credentials;
    pendingAuth?: PendingAuth;
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
 * Resolve a project flag (name, slug, or ID) to an actual project ID.
 * When no flag is given, falls back to the linked cwd. Hits the API only
 * when a flag is provided so name/slug lookups work as advertised.
 */
export declare function resolveProjectId(flagValue?: string): Promise<string>;
