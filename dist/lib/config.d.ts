export interface ProjectConfig {
    workspaceId?: string;
    projectId: string;
    projectName?: string;
    environment?: string;
}
export interface GlobalSettings {
    defaultWorkspace?: string;
}
/** Find project config by walking up from cwd */
export declare function findProjectConfig(): ProjectConfig | null;
/** Save project config in cwd */
export declare function saveProjectConfig(config: ProjectConfig): void;
export declare function loadGlobalSettings(): GlobalSettings;
export declare function saveGlobalSettings(settings: GlobalSettings): void;
/**
 * Resolve projectId from: --project flag → .lizard/config.json → error
 */
export declare function resolveProjectId(flagValue?: string): string;
/**
 * Resolve environment from: --environment flag → .lizard/config.json → "production"
 */
export declare function resolveEnvironment(flagValue?: string): string;
