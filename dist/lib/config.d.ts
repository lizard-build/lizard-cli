export interface ProjectConfig {
    workspaceId?: string;
    projectId: string;
    projectName?: string;
    environment?: string;
}
export interface GlobalSettings {
    defaultWorkspace?: string;
    defaultProject?: string;
    defaultProjectName?: string;
}
/** Find project config by walking up from cwd */
export declare function findProjectConfig(): ProjectConfig | null;
/** Save project config in cwd */
export declare function saveProjectConfig(config: ProjectConfig): void;
export declare function loadGlobalSettings(): GlobalSettings;
export declare function saveGlobalSettings(settings: GlobalSettings): void;
/**
 * Resolve projectId. Priority:
 *   1. --project flag
 *   2. .lizard/config.json (directory link)
 *   3. ~/.lizard/settings.json → defaultProject (unless localOnly)
 *   4. error
 *
 * `localOnly: true` forbids the global fallback — used by destructive commands
 * like `deploy` that act on cwd and must not silently target a different project.
 */
export declare function resolveProjectId(flagValue?: string, opts?: {
    localOnly?: boolean;
}): string;
/**
 * Resolve environment from: --environment flag → .lizard/config.json → "production"
 */
export declare function resolveEnvironment(flagValue?: string): string;
