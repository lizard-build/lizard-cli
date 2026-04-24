import chalk from "chalk";
import { api } from "../lib/api.js";
import { resolveProjectId } from "../lib/config.js";
import { isJSONMode, printJSON, statusColor, table } from "../lib/format.js";
export function registerStatus(program) {
    program
        .command("status")
        .description("Show project status")
        .action(async () => {
        const projectId = resolveProjectId(program.opts().project);
        const [project, services] = await Promise.all([
            api.get(`/api/projects/${projectId}`),
            api.get(`/api/projects/${projectId}/services`),
        ]);
        if (isJSONMode()) {
            printJSON({ project, services });
            return;
        }
        console.log(chalk.bold(project.name) + chalk.dim(` (${project.id})`));
        console.log();
        const allServices = [
            ...(services.apps || []).map((a) => ({
                name: a.name,
                type: "app",
                status: a.status,
                url: a.domain ? `https://${a.domain}` : "",
            })),
            ...(services.addons || []).map((a) => ({
                name: a.name || a.addonType,
                type: a.addonType || "addon",
                status: a.status,
                url: a.hostname || "",
            })),
        ];
        if (allServices.length === 0) {
            console.log(chalk.dim("No services"));
            return;
        }
        table(["Name", "Type", "Status", "URL"], allServices.map((s) => [
            s.name,
            s.type,
            statusColor(s.status),
            s.url || chalk.dim("—"),
        ]));
    });
}
//# sourceMappingURL=status.js.map