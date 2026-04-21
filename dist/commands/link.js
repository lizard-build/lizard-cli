import chalk from "chalk";
import * as p from "@clack/prompts";
import { api } from "../lib/api.js";
import { saveProjectConfig, findProjectConfig } from "../lib/config.js";
import { success, isJSONMode, printJSON, isTTY } from "../lib/format.js";
export function registerLink(program) {
    program
        .command("link")
        .description("Link current directory to an existing project")
        .option("--project <id>", "Project ID")
        .action(async (opts) => {
        let projectId = opts.project;
        let projectName;
        if (!projectId) {
            // Fetch projects and let user pick
            const projects = await api.get("/api/projects");
            if (projects.length === 0) {
                throw new Error("No projects found. Run `lizard init` to create one.");
            }
            if (!isTTY()) {
                throw new Error("Use --project <id> in non-interactive mode. Available: " +
                    projects.map((p) => `${p.name} (${p.id})`).join(", "));
            }
            const selected = await p.select({
                message: "Select project",
                options: projects.map((proj) => ({
                    value: proj.id,
                    label: proj.name,
                    hint: proj.id,
                })),
            });
            if (p.isCancel(selected))
                process.exit(5);
            projectId = selected;
            projectName = projects.find((p) => p.id === projectId)?.name;
        }
        const old = findProjectConfig();
        saveProjectConfig({ projectId, projectName });
        if (isJSONMode()) {
            printJSON({ projectId, projectName });
        }
        else if (old?.projectId && old.projectId !== projectId) {
            success(`Relinked to ${chalk.bold(projectName || projectId)} (was ${old.projectName || old.projectId})`);
        }
        else {
            success(`Linked to ${chalk.bold(projectName || projectId)}`);
        }
    });
}
//# sourceMappingURL=link.js.map