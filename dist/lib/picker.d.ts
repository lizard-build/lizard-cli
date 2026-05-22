import { type Workspace } from "./api.js";
export declare function fetchWorkspaces(): Promise<Workspace[]>;
export declare function matchWorkspace(workspaces: Workspace[], idOrSlugOrName: string): Workspace | undefined;
/**
 * Resolve a workspace by flag value. Fetches the list once; throws with the
 * available names when the value doesn't match anything the user belongs to.
 */
export declare function resolveWorkspace(flagValue: string): Promise<Workspace>;
/**
 * Pick a workspace for project creation / linking.
 *
 *   1. --workspace flag wins.
 *   2. If only one workspace exists, auto-select it.
 *   3. Non-TTY → prefer personal, else first.
 *   4. TTY → prompt.
 *
 * `projectNameHint` lets the caller short-circuit when --name X uniquely
 * identifies a workspace (see init flow case 5).
 */
export declare function pickWorkspace(opts: {
    flag?: string;
    projectNameHint?: string;
    workspaces?: Workspace[];
}): Promise<Workspace>;
interface ProjectLite {
    id: string;
    name: string;
    slug: string;
    workspaceId?: string | null;
}
export declare function listProjectsInWorkspace(workspaceId: string): Promise<ProjectLite[]>;
export {};
