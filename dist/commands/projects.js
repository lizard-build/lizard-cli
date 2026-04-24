import chalk from "chalk";
import { api } from "../lib/api.js";
import { success, isJSONMode, printJSON, table } from "../lib/format.js";
export function registerProjects(program) {
    const proj = program
        .command("project")
        .description("Project management");
    proj
        .command("list")
        .description("List all projects")
        .action(async () => {
        const projects = await api.get("/api/projects");
        if (isJSONMode()) {
            printJSON(projects);
            return;
        }
        if (projects.length === 0) {
            console.log("No projects. Run `lizard init` to create one.");
            return;
        }
        table(["Name", "ID", "Role", "Members"], projects.map((p) => [
            p.name,
            p.id,
            p.role || "owner",
            String(p.memberCount || 1),
        ]));
    });
    proj
        .command("create")
        .argument("<name>", "Project name")
        .description("Create a new project without linking it to this directory")
        .action(async (name) => {
        const project = await api.post("/api/projects", { name });
        if (isJSONMode()) {
            printJSON(project);
        }
        else {
            success(`Project ${chalk.bold(project.name)} created`);
        }
    });
}
//# sourceMappingURL=projects.js.map