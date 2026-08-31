import chalk from "chalk";
import * as p from "@clack/prompts";
import { api, withQuery } from "../lib/api.js";
import { fetchWorkspaces, resolveWorkspace } from "../lib/picker.js";
import { isJSONMode, printJSON, table, success, info, isTTY } from "../lib/format.js";
/**
 * `lizard workspace` — create, list, and delete workspaces.
 *
 * Delete only removes empty workspaces (no projects, no sandboxes). Member
 * management (invite/remove/rename) intentionally lives in the dashboard, not
 * here, to keep the CLI surface narrow (Railway model).
 */
export function registerWorkspace(program) {
    const ws = program
        .command("workspace")
        .description("Create, list, and delete workspaces");
    ws.command("create")
        .argument("<name>", "Workspace name")
        .description("Create a new workspace")
        .action(async (name) => {
        const workspace = await api.post("/api/workspaces", { name });
        if (isJSONMode()) {
            printJSON(workspace);
            return;
        }
        success(`Workspace ${chalk.bold(workspace.name)} created`);
        info(chalk.dim(`  Slug: ${workspace.slug}`));
        info(chalk.dim(`  Add a project: lizard project create <name> --workspace ${workspace.slug}`));
    });
    ws.command("list")
        .alias("ls")
        .description("List workspaces you belong to")
        .action(async () => {
        const list = await fetchWorkspaces();
        if (isJSONMode()) {
            printJSON(list);
            return;
        }
        if (list.length === 0) {
            console.log("No workspaces. The backend should always return a personal workspace.");
            return;
        }
        table(["Name", "Slug", "Role", "Projects", "Personal"], list.map((w) => [
            w.name,
            w.slug,
            w.role,
            String(w.projectCount ?? 0),
            w.isPersonal ? chalk.green("✓") : "",
        ]));
    });
    ws.command("rm")
        .alias("delete")
        .argument("<name-or-id>", "Workspace name, slug, or ID")
        .description("Delete an empty workspace")
        .option("-y, --yes", "Skip confirmation")
        .action(async (nameOrId, opts) => {
        const workspace = await resolveWorkspace(nameOrId);
        if (workspace.isPersonal) {
            throw new Error("Cannot delete your personal workspace.");
        }
        if (workspace.role !== "owner") {
            throw new Error("Only the workspace owner can delete it.");
        }
        // Empty workspaces only. Check here for a clear message; the backend
        // enforces the same via ?requireEmpty=true and also refuses if any
        // sandbox remains (which the CLI can't count on its own).
        const projectCount = workspace.projectCount ?? 0;
        if (projectCount > 0) {
            throw new Error(`Workspace "${workspace.name}" has ${projectCount} project(s). Delete them first, or use the dashboard to remove everything.`);
        }
        if (!opts.yes && isTTY() && !isJSONMode()) {
            const ok = await p.confirm({ message: `Delete workspace ${chalk.bold(workspace.name)}?` });
            if (p.isCancel(ok) || !ok)
                process.exit(5);
        }
        await api.delete(withQuery(`/api/workspaces/${workspace.id}`, { requireEmpty: true }));
        if (isJSONMode())
            printJSON({ id: workspace.id, status: "deleted" });
        else
            success(`Workspace ${chalk.bold(workspace.name)} deleted`);
    });
}
//# sourceMappingURL=workspace.js.map