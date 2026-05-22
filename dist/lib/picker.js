import * as p from "@clack/prompts";
import { api, withQuery } from "./api.js";
import { isTTY } from "./format.js";
export async function fetchWorkspaces() {
    return api.get("/api/workspaces");
}
export function matchWorkspace(workspaces, idOrSlugOrName) {
    const lower = idOrSlugOrName.toLowerCase();
    return workspaces.find((w) => w.id.toLowerCase() === lower ||
        w.slug.toLowerCase() === lower ||
        w.name.toLowerCase() === lower);
}
/**
 * Resolve a workspace by flag value. Fetches the list once; throws with the
 * available names when the value doesn't match anything the user belongs to.
 */
export async function resolveWorkspace(flagValue) {
    const workspaces = await fetchWorkspaces();
    const match = matchWorkspace(workspaces, flagValue);
    if (!match) {
        throw new Error(`Workspace "${flagValue}" not found. Available: ${workspaces.map((w) => w.name).join(", ") || "(none)"}`);
    }
    return match;
}
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
export async function pickWorkspace(opts) {
    if (opts.flag)
        return resolveWorkspace(opts.flag);
    const list = opts.workspaces ?? (await fetchWorkspaces());
    if (list.length === 0) {
        throw new Error("No workspaces available. The backend should always return a personal workspace — please report this.");
    }
    if (list.length === 1)
        return list[0];
    // Hint-based auto-pick: a --name match that is unique across workspaces.
    if (opts.projectNameHint) {
        const matches = await findWorkspacesContainingProject(list, opts.projectNameHint);
        if (matches.length === 1)
            return matches[0].workspace;
        if (matches.length > 1) {
            const detail = matches
                .map((m) => `  • ${m.project.name}  in ${m.workspace.name}  (--workspace ${m.workspace.slug})`)
                .join("\n");
            throw new Error(`Multiple projects named "${opts.projectNameHint}" found:\n${detail}\nPass --workspace, or run \`lizard init\` without --name to choose interactively.`);
        }
    }
    if (!isTTY()) {
        // Non-TTY fallback: personal first, else first ws.
        const personal = list.find((w) => w.isPersonal);
        return personal ?? list[0];
    }
    const sel = await p.select({
        message: "Workspace",
        options: list.map((w) => ({
            value: w.id,
            label: w.name,
            hint: `${w.role}${w.isPersonal ? " · personal" : ""} · ${w.projectCount ?? 0} project${(w.projectCount ?? 0) === 1 ? "" : "s"}`,
        })),
    });
    if (p.isCancel(sel))
        process.exit(5);
    return list.find((w) => w.id === sel);
}
async function findWorkspacesContainingProject(workspaces, nameOrSlugOrId) {
    const all = await api.get("/api/projects");
    const lower = nameOrSlugOrId.toLowerCase();
    const matches = [];
    for (const w of workspaces) {
        const inWs = all.find((pr) => pr.workspaceId === w.id &&
            (pr.id.toLowerCase() === lower ||
                pr.slug.toLowerCase() === lower ||
                pr.name.toLowerCase() === lower));
        if (inWs)
            matches.push({ workspace: w, project: inWs });
    }
    return matches;
}
export async function listProjectsInWorkspace(workspaceId) {
    return api.get(withQuery("/api/projects", { workspaceId }));
}
//# sourceMappingURL=picker.js.map