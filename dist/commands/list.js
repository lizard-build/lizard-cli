import { api } from "../lib/api.js";
import { isJSONMode, printJSON, table } from "../lib/format.js";
/**
 * `lizard list` — Railway-style project list. Equivalent to the legacy
 * `lizard project list`.
 */
export function registerList(program) {
    program
        .command("list")
        .alias("ls")
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
//# sourceMappingURL=list.js.map