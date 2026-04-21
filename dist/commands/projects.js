import { api } from "../lib/api.js";
import { isJSONMode, printJSON, table } from "../lib/format.js";
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
}
//# sourceMappingURL=projects.js.map