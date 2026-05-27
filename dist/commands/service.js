import chalk from "chalk";
import * as p from "@clack/prompts";
import { api, withScope, withQuery } from "../lib/api.js";
import { updateProjectLink, getProjectLink } from "../lib/config.js";
import { resolveProjectScope, resolveService } from "../lib/resolve.js";
import { validateName } from "../lib/name.js";
import { registerServiceSet } from "./service-set.js";
import { registerServiceShow } from "./service-show.js";
import { success, info, isJSONMode, printJSON, isTTY, } from "../lib/format.js";
/**
 * `lizard service` — service group:
 *   - bare: link a service to cwd
 *   - list / link / status / delete / rename / set / show / logs
 *   (scale / redeploy / restart live on the top-level commands of the same name)
 */
export function registerService(program) {
    const svc = program
        .command("service")
        .argument("[name]", "Service name to link (legacy form for `service link <name>`)")
        .description("Manage services")
        .action(async (name, _opts, cmd) => {
        // No subcommand → behave like `service link`
        if (!name && cmd.args.length === 0) {
            await linkInteractive(cmd);
            return;
        }
        if (name) {
            await linkByName(cmd, name);
        }
    });
    // `service set` and `service show` — per-service configuration patches.
    // Live in their own files because the apply logic is substantial.
    registerServiceSet(svc);
    registerServiceShow(svc);
    svc
        .command("link")
        .argument("[name]", "Service name or ID")
        .description("Link a service to the current directory")
        .action(async (name, _opts, sub) => {
        if (name) {
            await linkByName(sub, name);
        }
        else {
            await linkInteractive(sub);
        }
    });
    svc
        .command("delete")
        .alias("rm")
        .description("Delete a service")
        .argument("[service]", "Service name or ID (defaults to linked)")
        .option("-s, --service <name>", "Service name or ID")
        .option("-p, --project <id>", "Project name, slug, or ID")
        .option("-y, --yes", "Skip confirmation")
        .action(async (serviceArg, opts) => {
        const { projectId, scope } = await resolveProjectScope(opts.project);
        const target = serviceArg || opts.service || getProjectLink()?.serviceId;
        if (!target)
            throw new Error("No service specified or linked.");
        const svcInfo = await resolveService(projectId, target);
        const yes = opts.yes;
        if (!yes) {
            if (!isTTY())
                throw new Error("Use -y to confirm in non-interactive mode");
            const confirm = await p.confirm({
                message: `Delete ${chalk.bold(svcInfo.name)}? This is irreversible.`,
            });
            if (p.isCancel(confirm) || !confirm)
                process.exit(5);
        }
        if (svcInfo.kind === "app") {
            await api.delete(withScope(`/api/apps/${svcInfo.id}`, scope));
        }
        else {
            await api.delete(withScope(`/api/projects/${projectId}/addons/${svcInfo.id}`, scope));
        }
        // Clear link if we just deleted the linked service
        const link = getProjectLink();
        if (link?.serviceId === svcInfo.id) {
            updateProjectLink({ serviceId: undefined, serviceName: undefined });
        }
        if (isJSONMode()) {
            printJSON({ id: svcInfo.id, name: svcInfo.name, status: "deleted" });
        }
        else {
            success(`Service ${chalk.bold(svcInfo.name)} deleted`);
        }
    });
    svc
        .command("rename")
        .argument("<new-name>", "New name for the service")
        .description("Rename a service (apps and addons)")
        .option("-s, --service <name>", "Service name or ID (defaults to linked service)")
        .option("-p, --project <id>", "Project name, slug, or ID")
        .action(async (newName, opts) => {
        const nameErr = validateName(newName);
        if (nameErr)
            throw new Error(`Invalid name: ${nameErr}`);
        const { projectId, scope } = await resolveProjectScope(opts.project);
        const target = opts.service || getProjectLink()?.serviceId;
        if (!target)
            throw new Error("No service specified or linked.");
        const svcInfo = await resolveService(projectId, target);
        if (svcInfo.kind === "app") {
            // PATCH /api/apps/:id is 410-Gone; renames go through config:apply.
            // Backend treats name as a rename only when id is also in the patch
            // (otherwise name is a lookup key).
            await api.post(withScope(`/api/projects/${projectId}/config:apply`, scope), { services: [{ id: svcInfo.id, name: newName }] });
        }
        else {
            await api.patch(withScope(`/api/projects/${projectId}/addons/${svcInfo.id}`, scope), { name: newName });
        }
        // Keep the cwd link's cached name in sync when we just renamed the linked one.
        const link = getProjectLink();
        if (link?.serviceId === svcInfo.id) {
            updateProjectLink({ serviceId: svcInfo.id, serviceName: newName });
        }
        if (isJSONMode()) {
            printJSON({ id: svcInfo.id, oldName: svcInfo.name, name: newName });
        }
        else {
            success(`Renamed ${chalk.bold(svcInfo.name)} → ${chalk.bold(newName)}`);
        }
    });
    svc
        .command("logs")
        .description("Stream logs of a service")
        .argument("[service]", "Service name or ID (defaults to linked)")
        .option("-s, --service <name>", "Service name or ID")
        .option("-p, --project <id>", "Project name, slug, or ID")
        .option("--build", "Show build logs instead of runtime")
        .option("-n, --tail <n>", "Print last N lines and exit (no follow); use --tail all for full history")
        .option("--page <n>", "Page of historical logs (1=most recent, 2=older, …); implies --tail 200")
        .action(async (serviceArg, opts) => {
        const { projectId, scope } = await resolveProjectScope(opts.project);
        const target = serviceArg || opts.service || getProjectLink()?.serviceId;
        if (!target)
            throw new Error("No service specified or linked.");
        const svcInfo = await resolveService(projectId, target);
        const { streamSSE } = await import("../lib/api.js");
        if (opts.build) {
            const app = await api.get(withScope(`/api/apps/${svcInfo.id}`, scope));
            if (!app.builds?.length)
                throw new Error("No builds found");
            info(chalk.dim(`Streaming build logs for ${svcInfo.name}...\n`));
            await streamSSE(`/api/builds/${app.builds[0].id}/logs`, (event, data) => {
                if (event === "done" || event === "error")
                    return false;
                process.stdout.write(safeLogLine(data) + "\n");
                return true;
            });
            return;
        }
        // --page: paginate through historical logs without streaming
        if (opts.page !== undefined) {
            const pageSize = 200;
            const pageNum = Math.max(1, parseInt(opts.page, 10) || 1);
            // Fetch pages iteratively: page 1 = most recent, page 2 = one step older, etc.
            let before;
            for (let p = 1; p <= pageNum; p++) {
                const result = await api.get(withScope(withQuery(`/api/apps/${svcInfo.id}/logs/history`, {
                    limit: pageSize,
                    before,
                }), scope));
                if (p === pageNum) {
                    if (!result.entries.length) {
                        info(chalk.dim("No more logs."));
                    }
                    else {
                        info(chalk.dim(`Page ${pageNum} (${result.entries.length} lines):\n`));
                        for (const e of result.entries)
                            process.stdout.write(safeLogLine(JSON.stringify(e)) + "\n");
                        if (result.oldest)
                            info(chalk.dim(`\n  --page ${pageNum + 1}  for older logs`));
                    }
                }
                else {
                    if (!result.entries.length || !result.entries[0])
                        break;
                    before = result.entries[0].id; // oldest entry of this page → upper bound for next
                }
            }
            return;
        }
        // --tail N: fetch N historical lines and exit (no follow)
        if (opts.tail !== undefined) {
            const rawTail = String(opts.tail);
            const limit = rawTail === "all" ? 2000 : Math.min(Math.max(1, parseInt(rawTail, 10) || 200), 2000);
            const result = await api.get(withScope(withQuery(`/api/apps/${svcInfo.id}/logs/history`, { limit }), scope));
            for (const e of result.entries)
                process.stdout.write(safeLogLine(JSON.stringify(e)) + "\n");
            if (result.oldest && result.entries.length === limit) {
                info(chalk.dim(`\n  Showing last ${limit} lines. Use --tail all or --page 2 to see older logs.`));
            }
            return;
        }
        info(chalk.dim(`Streaming logs for ${svcInfo.name}... (Ctrl+C to stop)\n`));
        await streamSSE(withScope(withQuery(`/api/apps/${svcInfo.id}/logs`, { limit: 500 }), scope), (event, data) => {
            if (event === "error")
                return false;
            process.stdout.write(safeLogLine(data) + "\n");
            return true;
        });
    });
    // Helpers in scope of registerService
    async function linkByName(_cmd, name) {
        const { projectId } = await resolveProjectScope(undefined);
        const svcInfo = await resolveService(projectId, name);
        updateProjectLink({ serviceId: svcInfo.id, serviceName: svcInfo.name });
        if (isJSONMode()) {
            printJSON({ serviceId: svcInfo.id, serviceName: svcInfo.name });
        }
        else {
            success(`Linked service ${chalk.bold(svcInfo.name)}`);
        }
    }
    async function linkInteractive(_cmd) {
        const { projectId, scope } = await resolveProjectScope(undefined);
        const data = await api.get(withScope(`/api/projects/${projectId}/services`, scope));
        const services = [...(data.apps || []), ...(data.addons || [])];
        if (services.length === 0) {
            throw new Error("No services in project. Use `lizard add` first.");
        }
        if (!isTTY()) {
            throw new Error("Service name required in non-interactive mode. Usage: `lizard service link <name>`");
        }
        const sel = await p.select({
            message: "Select a service",
            options: services.map((s) => ({
                value: s.id,
                label: s.name || s.addonType,
                hint: s.status,
            })),
        });
        if (p.isCancel(sel))
            process.exit(5);
        const svcInfo = services.find((s) => s.id === sel);
        updateProjectLink({ serviceId: svcInfo.id, serviceName: svcInfo.name });
        if (isJSONMode()) {
            printJSON({ serviceId: svcInfo.id, serviceName: svcInfo.name });
        }
        else {
            success(`Linked service ${chalk.bold(svcInfo.name)}`);
        }
    }
}
function safeLogLine(data) {
    try {
        const parsed = JSON.parse(data);
        if (parsed.line)
            return parsed.line;
        if (parsed.message)
            return parsed.message;
        if (typeof parsed === "string")
            return parsed;
        return data;
    }
    catch {
        return data;
    }
}
//# sourceMappingURL=service.js.map