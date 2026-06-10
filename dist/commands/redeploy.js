import chalk from "chalk";
import ora from "ora";
import * as p from "@clack/prompts";
import { api, streamSSE, withScope } from "../lib/api.js";
import { resolveProjectScope, resolveService } from "../lib/resolve.js";
import { success, info, error, isJSONMode, printJSON, isTTY } from "../lib/format.js";
export function registerRedeploy(program) {
    program
        .command("redeploy")
        .argument("[nameOrId]", "App name or ID to redeploy")
        .description("Trigger a fresh build (latest commit / last upload) with current vars")
        .option("--detach", "Run in background")
        .option("-s, --service <name>", "App name or ID (alias for positional)")
        .option("-p, --project <id>", "Project name, slug, or ID")
        .action(async (nameOrId, opts) => {
        const ref = nameOrId || opts.service;
        let id;
        if (ref) {
            const { projectId } = await resolveProjectScope(opts.project);
            const resolved = await resolveService(projectId, ref);
            if (resolved.kind !== "app") {
                throw new Error(`"${ref}" is not an app`);
            }
            id = resolved.id;
        }
        else {
            if (!isTTY())
                throw new Error("Provide an app name or ID, or run interactively");
            const { projectId, scope } = await resolveProjectScope(opts.project);
            const data = await api.get(withScope(`/api/projects/${projectId}/services`, scope));
            const apps = data.apps || [];
            if (apps.length === 0) {
                throw new Error("No apps in project. Create one with `lizard up` or `lizard add`.");
            }
            if (apps.length === 1) {
                id = apps[0].id;
            }
            else {
                const selected = await p.select({
                    message: "Select app to redeploy",
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
        const spinner = ora("Starting redeploy...").start();
        // The endpoint pre-creates and returns the Build record — use its id
        // instead of polling builds[0], which races against a previous build.
        const build = await api.post(`/api/apps/${id}/redeploy`, undefined, { "X-Deploy-Source": "cli" });
        spinner.stop();
        if (opts.detach || isJSONMode()) {
            if (isJSONMode()) {
                printJSON({ id, buildId: build?.id, status: "deploying" });
            }
            else {
                success("Redeploy started");
                info(chalk.dim(`  Check status: lizard up status ${id}`));
            }
            return;
        }
        info("Redeploying...");
        let buildId = build?.id ?? null;
        // Fallback for older servers that respond without a Build record.
        for (let i = 0; !buildId && i < 30; i++) {
            await new Promise((r) => setTimeout(r, 2000));
            try {
                const app = await api.get(`/api/apps/${id}`);
                if (app.builds?.length) {
                    const latest = app.builds[0];
                    if (["building", "deploying", "running", "failed"].includes(latest.status)) {
                        buildId = latest.id;
                        break;
                    }
                }
            }
            catch { }
        }
        if (buildId) {
            await streamSSE(`/api/builds/${buildId}/logs`, (event, data) => {
                if (event === "done" || event === "error") {
                    if (event === "error")
                        error(`Build failed: ${data}`);
                    return false;
                }
                try {
                    const parsed = JSON.parse(data);
                    const line = typeof parsed === "string" ? parsed : (parsed.line ?? data);
                    process.stdout.write(line + "\n");
                }
                catch {
                    process.stdout.write(data + "\n");
                }
                return true;
            });
        }
        const app = await api.get(`/api/apps/${id}`);
        if (app.status === "running") {
            success(`Redeployed! ${app.domain ? chalk.cyan(`https://${app.domain}`) : ""}`);
        }
        else {
            error("Redeploy failed");
        }
    });
}
//# sourceMappingURL=redeploy.js.map