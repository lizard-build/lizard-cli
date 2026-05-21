import chalk from "chalk";
import ora from "ora";
import * as p from "@clack/prompts";
import { api } from "../lib/api.js";
import { resolveProjectId } from "../lib/config.js";
import { resolveService } from "../lib/resolve.js";
import { success, info, error, isJSONMode, printJSON, isTTY } from "../lib/format.js";
export function registerRestart(program) {
    program
        .command("restart")
        .argument("[nameOrId]", "App name or ID to restart")
        .description("Restart an app")
        .option("--detach", "Run in background")
        .option("-s, --service <name>", "App name or ID (alias for positional)")
        .option("-p, --project <id>", "Project name or ID")
        .action(async (nameOrId, opts) => {
        const ref = nameOrId || opts.service;
        let id;
        if (ref) {
            const projectId = await resolveProjectId(opts.project);
            const resolved = await resolveService(projectId, ref);
            if (resolved.kind !== "app") {
                throw new Error(`"${ref}" is not an app`);
            }
            id = resolved.id;
        }
        else {
            if (!isTTY())
                throw new Error("Provide an app name or ID, or run interactively");
            const projectId = await resolveProjectId(opts.project);
            const data = await api.get(`/api/projects/${projectId}/services`);
            const apps = data.apps || [];
            if (apps.length === 0)
                throw new Error("No apps in project");
            if (apps.length === 1) {
                id = apps[0].id;
            }
            else {
                const selected = await p.select({
                    message: "Select app to restart",
                    options: apps.map((a) => ({
                        value: a.id,
                        label: a.name || a.id,
                        hint: a.status,
                    })),
                });
                if (p.isCancel(selected))
                    process.exit(5);
                id = selected;
            }
        }
        const spinner = ora("Starting restart...").start();
        await api.post(`/api/apps/${id}/restart`, undefined, { "X-Deploy-Source": "cli" });
        spinner.stop();
        if (opts.detach || isJSONMode()) {
            if (isJSONMode()) {
                printJSON({ id, status: "restarting" });
            }
            else {
                success("Restart started");
                info(chalk.dim(`  Check status: lizard ps ${id}`));
            }
            return;
        }
        const waitSpinner = ora("Restarting...").start();
        let finalStatus;
        let domain;
        for (let i = 0; i < 60; i++) {
            await new Promise((r) => setTimeout(r, 2000));
            try {
                const app = await api.get(`/api/apps/${id}`);
                domain = app.domain;
                if (app.status === "running") {
                    finalStatus = "running";
                    break;
                }
                if (app.status === "failed" || app.status === "error") {
                    finalStatus = app.status;
                    break;
                }
            }
            catch { }
        }
        waitSpinner.stop();
        if (finalStatus === "running") {
            success(`Restarted! ${domain ? chalk.cyan(`https://${domain}`) : ""}`);
        }
        else if (finalStatus) {
            error("Restart failed");
        }
        else {
            info(chalk.dim("Still restarting — check status with: lizard ps " + id));
        }
    });
}
//# sourceMappingURL=restart.js.map