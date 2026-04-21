import chalk from "chalk";
import { api } from "../lib/api.js";
import { resolveProjectId } from "../lib/config.js";
import { isJSONMode, printJSON, table, statusColor } from "../lib/format.js";
export function registerAddon(program) {
    const addon = program.command("addon").description("Manage addons");
    addon
        .command("list")
        .description("List addons in the project")
        .action(async () => {
        const projectId = resolveProjectId(program.opts().project);
        const data = await api.get(`/api/projects/${projectId}/services`);
        const addons = data.addons || [];
        if (isJSONMode()) {
            printJSON(addons);
            return;
        }
        if (addons.length === 0) {
            console.log("No addons. Use `lizard add` to create one.");
            return;
        }
        table(["Name", "Type", "Status", "Host"], addons.map((a) => [
            a.name || a.type,
            a.type,
            statusColor(a.status),
            a.hostname || chalk.dim("—"),
        ]));
    });
}
//# sourceMappingURL=addon.js.map