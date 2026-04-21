import chalk from "chalk";
import { api } from "../lib/api.js";
import { resolveProjectId } from "../lib/config.js";
import { isJSONMode, printJSON, table, statusColor, } from "../lib/format.js";
export function registerPs(program) {
    program
        .command("ps")
        .description("List all services in the project")
        .action(async () => {
        const projectId = resolveProjectId(program.opts().project);
        const data = await api.get(`/api/projects/${projectId}/services`);
        const services = [];
        for (const app of data.apps || []) {
            services.push({
                id: app.id,
                name: app.name,
                type: "app",
                status: app.status,
                domain: app.domain,
                createdAt: app.createdAt,
            });
        }
        for (const addon of data.addons || []) {
            services.push({
                id: addon.id,
                name: addon.name || addon.addonType,
                type: "addon",
                addonType: addon.addonType,
                status: addon.status,
                hostname: addon.hostname,
                createdAt: addon.createdAt,
            });
        }
        if (isJSONMode()) {
            printJSON(services);
            return;
        }
        if (services.length === 0) {
            console.log("No services. Use `lizard add` or `lizard deploy`.");
            return;
        }
        table(["Name", "Type", "Status", "URL/Host"], services.map((s) => [
            s.name,
            s.addonType || s.type,
            statusColor(s.status),
            s.domain
                ? `https://${s.domain}`
                : s.hostname || chalk.dim("—"),
        ]));
    });
}
//# sourceMappingURL=ps.js.map