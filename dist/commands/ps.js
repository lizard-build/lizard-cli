import chalk from "chalk";
import { api } from "../lib/api.js";
import { getProjectLink, resolveProjectId } from "../lib/config.js";
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
            console.log("No services. Use `lizard add` or `lizard up`.");
            return;
        }
        const linkedId = getProjectLink()?.serviceId;
        if (apps.length > 0) {
            table(["App", "Status", "URL", "Linked"], apps.map((a) => [
                a.name || a.id,
                statusColor(a.status),
                a.domain ? chalk.cyan(`https://${a.domain}`) : chalk.dim("—"),
                a.id === linkedId ? chalk.green("✓") : "",
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
            const withConn = addons.filter((a) => a.connection && (a.connection.internalUrl || a.connection.externalUrl || a.connection.endpoint));
            if (withConn.length > 0) {
                for (const a of withConn) {
                    console.log();
                    console.log(`  ${chalk.bold(a.name || a.type)} ${chalk.dim(`(${a.type})`)}`);
                    const c = a.connection;
                    if (c.internalUrl) {
                        console.log(`    ${chalk.dim("private:")} ${chalk.cyan(c.internalUrl)}`);
                    }
                    if (c.externalUrl) {
                        console.log(`    ${chalk.dim("public: ")} ${chalk.cyan(c.externalUrl)}`);
                    }
                    if (c.endpoint) {
                        console.log(`    ${chalk.dim("endpoint:")} ${chalk.cyan(c.endpoint)}`);
                        if (c.accessKeyId)
                            console.log(`    ${chalk.dim("key:     ")} ${chalk.dim(c.accessKeyId)}`);
                    }
                }
            }
        }
    });
}
//# sourceMappingURL=ps.js.map