import chalk from "chalk";
import path from "node:path";
import * as p from "@clack/prompts";
import { api } from "../lib/api.js";
import { getProjectLink, setProjectLink, } from "../lib/config.js";
import { success, info, isJSONMode, printJSON, isTTY, } from "../lib/format.js";
/**
 * Ensure the current directory is linked to a project. If already linked and
 * `force` is false, returns the existing link. Otherwise runs the
 * create-or-select flow.
 *
 * `projectName` (from --project) takes a name: matches an existing project by
 * name/slug or creates a new one with that name.
 */
export async function ensureLinked(opts = {}) {
    const existing = getProjectLink();
    if (existing && !opts.force) {
        if (!opts.relinkPrompt)
            return existing;
        if (!isTTY()) {
            throw new Error(`Already linked to ${existing.projectName || existing.projectId}. Use --force to relink.`);
        }
        const proceed = await p.confirm({
            message: `Directory is linked to "${existing.projectName || existing.projectId}". Relink?`,
            initialValue: false,
        });
        if (p.isCancel(proceed) || !proceed)
            return existing;
    }
    const projects = await api.get("/api/projects");
    let project;
    if (opts.projectName) {
        const match = projects.find((pr) => pr.name === opts.projectName ||
            pr.slug === opts.projectName ||
            pr.id === opts.projectName);
        project =
            match ??
                (await api.post("/api/projects", { name: opts.projectName }));
    }
    else if (!isTTY()) {
        project = await api.post("/api/projects", {
            name: path.basename(process.cwd()),
        });
    }
    else {
        let action = "create";
        if (projects.length > 0) {
            const choice = await p.select({
                message: "Link a project",
                options: [
                    { value: "create", label: "Create new project" },
                    { value: "select", label: "Select existing project" },
                ],
            });
            if (p.isCancel(choice))
                process.exit(5);
            action = choice;
        }
        if (action === "create") {
            const nameRes = await p.text({
                message: "Project name",
                defaultValue: path.basename(process.cwd()),
                placeholder: path.basename(process.cwd()),
            });
            if (p.isCancel(nameRes))
                process.exit(5);
            project = await api.post("/api/projects", {
                name: nameRes,
            });
        }
        else {
            const selected = await p.select({
                message: "Select project",
                options: projects.map((pr) => ({
                    value: pr.id,
                    label: pr.name,
                    hint: pr.id,
                })),
            });
            if (p.isCancel(selected))
                process.exit(5);
            project = projects.find((pr) => pr.id === selected);
        }
    }
    const link = {
        projectId: project.id,
        projectName: project.name,
    };
    setProjectLink(link);
    return link;
}
export function registerInit(program) {
    program
        .command("init")
        .description("Create or select a project and link it to the current directory")
        .option("-n, --name <name>", "Project name (use existing or create if missing)")
        .option("--project <name>", "Alias for --name (kept for backwards compat)")
        .option("--force", "Relink even if this directory is already linked")
        .action(async (opts) => {
        const projectName = opts.name || opts.project;
        const link = await ensureLinked({
            projectName,
            force: opts.force,
            relinkPrompt: true,
        });
        if (isJSONMode()) {
            printJSON({ projectId: link.projectId, name: link.projectName });
        }
        else {
            success(`Linked to ${chalk.bold(link.projectName || link.projectId)}`);
            info(chalk.dim("  Saved to ~/.lizard/config.json"));
        }
    });
}
//# sourceMappingURL=init.js.map