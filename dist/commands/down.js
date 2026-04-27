import chalk from "chalk";
import * as p from "@clack/prompts";
import { api } from "../lib/api.js";
import { resolveProjectId } from "../lib/config.js";
import { resolveService } from "../lib/resolve.js";
import { success, isJSONMode, printJSON, isTTY } from "../lib/format.js";
/**
 * `lizard down` — like `railway down`. Stops the deployment of a service
 * (or destroys the service when `--remove` is set, matching `destroy`).
 */
export function registerDown(program) {
    program
        .command("down")
        .argument("[id]", "Service ID or name (defaults to linked)")
        .description("Stop the latest deployment of a service")
        .option("-s, --service <name>", "Service name or ID")
        .option("-p, --project <id>", "Project name or ID")
        .option("-e, --environment <name>", "Environment name or ID")
        .option("--remove", "Permanently remove the service (alias to `lizard destroy`)")
        .option("-y, --yes", "Skip confirmation")
        .action(async (id, opts, cmd) => {
        const globalOpts = cmd.parent?.opts() || {};
        const projectId = resolveProjectId(opts.project);
        const yes = opts.yes || globalOpts.yes;
        const target = id || opts.service;
        if (!target) {
            throw new Error("Specify a service: positional ID or --service <name>.");
        }
        const svc = await resolveService(projectId, target);
        if (!yes) {
            if (!isTTY()) {
                throw new Error("Use -y to confirm in non-interactive mode");
            }
            const confirm = await p.confirm({
                message: opts.remove
                    ? `Permanently remove ${chalk.bold(svc.name)}?`
                    : `Stop the deployment of ${chalk.bold(svc.name)}?`,
            });
            if (p.isCancel(confirm) || !confirm)
                process.exit(5);
        }
        if (opts.remove) {
            if (svc.kind === "app") {
                await api.delete(`/api/apps/${svc.id}`);
            }
            else {
                await api.delete(`/api/projects/${projectId}/addons/${svc.id}`);
            }
            if (isJSONMode()) {
                printJSON({ id: svc.id, name: svc.name, status: "removed" });
            }
            else {
                success(`Service ${chalk.bold(svc.name)} removed`);
            }
            return;
        }
        // Stop deployment without removing the service
        await api.post(`/api/apps/${svc.id}/stop`).catch(async (err) => {
            if (err?.status === 404) {
                // fallback: tell user to use --remove
                throw new Error("Stop endpoint not available. Use `lizard down --remove` to delete, or contact support.");
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