export interface DefaultProject {
    id: string;
    name: string;
    slug: string;
    workspaceId: string;
    workspaceName: string;
}
/**
 * The default project, asked once per run. Null when the account has none, or
 * when the platform predates the route; callers then fail as they always did.
 * 401 still throws: that is a sign-in problem, not a missing project.
 */
export declare function defaultProject(): Promise<DefaultProject | null>;
/** Say once per run which project an unlinked folder ended up in, and how to choose another. */
export declare function noteDefaultProject(name: string): void;
/** For tests: forget the cached answer. */
export declare function resetDefaultProject(): void;
