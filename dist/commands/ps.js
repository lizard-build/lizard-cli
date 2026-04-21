import chalk from "chalk";
import { api } from "../lib/api.js";
import { resolveProjectId } from "../lib/config.js";
import { isJSONMode, printJSON, table, statusColor } from "../lib/format.js";
export function registerPs(program) {
    program
        .command("ps")
        .description("List all services in the project")
        .action(async () => {
        const projectId = resolveProjectId(program.opts().project);
        const data = await api.get(`/api/projects/${projectId}/services`);
        if (isJSONMode()) {
            printJSON(data);
            return;
        }
        const apps = data.apps || [];
        const addons = data.addons || [];
        if (apps.length === 0 && addons.length === 0) {
            console.log("No services. Use `lizard add` or `lizard deploy`.");
            return;
        }
        if (apps.length > 0) {
            table(["App", "Status", "URL"], apps.map((a) => [
                a.name || a.id,
                statusColor(a.status),
                a.domain ? chalk.cyan(`https://${a.domain}`) : chalk.dim("—"),
            ]));
        }
        if (addons.length > 0) {
            if (apps.length > 0)
                console.log();
            table(["Addon", "Type", "Status", "Host"], addons.map((a) => [
                a.name || a.type,
                a.type,
                statusColor(a.status),
                a.hostname ? chalk.dim(a.hostname) : chalk.dim("—"),
            ]));
            // Show env vars for running addons
            const withEnv = addons.filter((a) => a.envVars && Object.keys(a.envVars).length > 0);
            if (withEnv.length > 0) {
                console.log();
                console.log(chalk.dim("  Connection strings:"));
                for (const a of withEnv) {
                    for (const [key, val] of Object.entries(a.envVars)) {
                        console.log(`  ${chalk.bold(key)}=${chalk.dim(val)}`);
                    }
                }
            }
        }
    });
}
//# sourceMappingURL=ps.js.map