import chalk from "chalk";
import { api, withScope } from "../lib/api.js";
import { getActiveServiceWithKind, resolveProjectScope } from "../lib/resolve.js";
import { success, warn, info, isJSONMode, printJSON } from "../lib/format.js";
/** The API path that pauses or resumes one service: an app, or a managed database (addon). */
export function servicePausePath(op, svc, projectId, scope) {
    return svc.kind === "app"
        ? withScope(`/api/apps/${svc.id}/${op}`, scope)
        : withScope(`/api/projects/${projectId}/addons/${svc.id}/${op}`, scope);
}
/** Human output for a project / workspace pause or resume: what was done, and what was not and why. */
export function printBulkResult(op, target, result) {
    const verb = op === "pause" ? "Paused" : "Resumed";
    if (result.done.length === 0 && result.skipped.length === 0) {
        info(`${target}: nothing to ${op}`);
        return;
    }
    if (result.done.length) {
        success(`${verb} ${result.done.length} service${result.done.length === 1 ? "" : "s"} in ${target}`);
        for (const s of result.done)
            info(`  ${chalk.bold(s.name)} ${chalk.dim(`(${s.kind})`)}`);
    }
    if (result.skipped.length) {
        warn(`Skipped ${result.skipped.length}:`);
        for (const s of result.skipped)
            info(`  ${chalk.bold(s.name)} ${chalk.dim(`(${s.kind})`)} — ${s.reason}`);
    }
}
/**
 * `lizard pause [service]` / `lizard resume [service]` — stop one app or database without
 * deleting it, or start it again. Paused, it scales to 0 (an app's URL answers 503, a database
 * refuses connections) and keeps its URL, host, port, password, settings and volumes.
 */
export function registerPause(program) {
    for (const op of ["pause", "resume"]) {
        program
            .command(op)
            .description(op === "pause"
            ? "Pause a service (app or database): scale to 0, keep its URL, password, settings and data"
            : "Resume a paused service (app or database)")
            .argument("[service]", "Service name or ID (defaults to linked)")
            .option("-s, --service <name>", "Service name or ID")
            .option("-p, --project <id>", "Project name, slug, or ID")
            .action(async (serviceArg, opts) => {
            const { projectId, scope } = await resolveProjectScope(opts.project);
            const svc = await getActiveServiceWithKind(serviceArg || opts.service, projectId);
            const result = await api.post(servicePausePath(op, svc, projectId, scope));
            if (isJSONMode()) {
                printJSON({ id: svc.id, name: svc.name, kind: svc.kind, status: result?.status ?? (op === "pause" ? "paused" : "running") });
                return;
            }
            if (op === "pause") {
                success(`Paused ${chalk.bold(svc.name)}`);
                info(chalk.dim(`  Its URL, password, settings and data are kept. Start it again: lizard resume ${svc.name}`));
            }
            else {
                success(`Resumed ${chalk.bold(svc.name)}`);
            }
        });
    }
}
//# sourceMappingURL=pause.js.map