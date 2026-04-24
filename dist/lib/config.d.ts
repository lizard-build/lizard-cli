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
    appId?: string;
    appName?: string;
}
export interface Config {
    credentials?: Credentials;
    projects?: Record<string, ProjectLink>;
}
export declare function loadConfig(): Config;
export declare function saveConfig(config: Config): void;
export declare function getProjectLink(cwd?: string): ProjectLink | null;
export declare function setProjectLink(link: ProjectLink, cwd?: string): void;
export declare function updateProjectLink(patch: Partial<ProjectLink>, cwd?: string): void;
/**
 * Resolve projectId from: --project flag (ID only) → linked cwd → error.
 * For name-based resolution, callers should look up the project list first.
 */
export declare function resolveProjectId(flagValue?: string): string;
