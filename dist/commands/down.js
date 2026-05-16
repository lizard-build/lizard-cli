import chalk from "chalk";
import * as p from "@clack/prompts";
import { api } from "../lib/api.js";
import { resolveProjectId } from "../lib/config.js";
import { getActiveService } from "../lib/resolve.js";
import { success, isJSONMode, printJSON, isTTY } from "../lib/format.js";
/**
 * `lizard down` — stops the latest deployment of a service.
 * The service itself is preserved; use `lizard service rm` to delete it.
 */
export function registerDown(program) {
    program
        .command("down")
        .argument("[id]", "Service ID or name (defaults to linked)")
        .description("Stop the latest deployment of a service")
        .option("-s, --service <name>", "Service name or ID")
        .option("-p, --project <id>", "Project name or ID")
        .option("-e, --environment <name>", "Environment name or ID")
        .option("-y, --yes", "Skip confirmation")
        .action(async (id, opts) => {
        const projectId = resolveProjectId(opts.project);
        const yes = opts.yes;
        const svc = await getActiveService(id || opts.service, projectId);
        if (!yes) {
            if (!isTTY()) {
                throw new Error("Use -y to confirm in non-interactive mode");
            }
            const confirm = await p.confirm({
                message: `Stop the deployment of ${chalk.bold(svc.name)}?`,
            });
            if (p.isCancel(confirm) || !confirm)
                process.exit(5);
        }
        await api.post(`/api/apps/${svc.id}/stop`).catch((err) => {
            if (err?.status === 404) {
                throw new Error("Stop endpoint not available. Use `lizard service rm` to delete the service.");
            }
            throw err;
        });
        if (isJSONMode()) {
            printJSON({ id: svc.id, name: svc.name, status: "stopped" });
        }
        else {
            success(`${chalk.bold(svc.name)} stopped`);
        }
    });
}
//# sourceMappingURL=down.js.map