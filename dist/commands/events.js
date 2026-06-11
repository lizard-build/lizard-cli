import chalk from "chalk";
import { api } from "../lib/api.js";
import { resolveProjectScope, getActiveServiceWithKind } from "../lib/resolve.js";
import { info, error, isJSONMode, printJSON, table, statusColor, timeAgo } from "../lib/format.js";
export function registerEvents(program) {
    program
        .command("events")
        .description("Show deploy history and replica status for an app")
        .option("-s, --service <id>", "Service name or ID (defaults to linked service)")
        .option("-p, --project <id>", "Project name, slug, or ID")
        .option("-n, --limit <n>", "Max deploys to show", "10")
        .action(async (opts) => {
        const n = parseInt(opts.limit, 10);
        if (isNaN(n) || n < 1) {
            error("--limit must be a positive integer");
            process.exit(1);
        }
        const { projectId } = await resolveProjectScope(opts.project);
        const svc = await getActiveServiceWithKind(opts.service, projectId);
        if (svc.kind === "addon") {
            error(`Deploy events are only available for apps — "${svc.name}" is an addon`);
            process.exit(1);
        }
        const [builds, podStatus] = await Promise.all([
            api.get(`/api/apps/${svc.id}/deploy-events`),
            api
                .get(`/api/apps/${svc.id}/pod-status`)
                .catch(() => ({ pods: [] })),
        ]);
        const slice = builds.slice(0, n);
        if (isJSONMode()) {
            printJSON({
                service: { id: svc.id, name: svc.name },
                pods: podStatus.pods,
                deploys: slice,
            });
            return;
        }
        if (podStatus.pods.length > 0) {
            console.log(chalk.bold("Replicas"));
            table(["Name", "Phase", "Ready", "Restarts", "Started", "Reason"], podStatus.pods.map((pod) => [
                pod.name,
                statusColor(pod.phase.toLowerCase()),
                pod.ready ? chalk.green("✓") : chalk.red("✗"),
                String(pod.restarts),
                pod.startedAt ? timeAgo(pod.startedAt) : chalk.dim("—"),
                pod.reason || chalk.dim("—"),
            ]));
            console.log();
        }
        if (slice.length === 0) {
            info(chalk.dim(`No deploys for ${svc.name} yet.`));
            return;
        }
        console.log(chalk.bold("Deploys"));
        table(["When", "Status", "Trigger", "Commit", "Restarts", "Build"], slice.map((b) => [
            timeAgo(b.createdAt),
            statusColor(b.status),
            b.trigger ?? chalk.dim("—"),
            b.commitSha ? b.commitSha.slice(0, 7) : chalk.dim("—"),
            b.events.length > 0 ? chalk.yellow(String(b.events.length)) : chalk.dim("0"),
            chalk.dim(b.buildId),
        ]));
        if (builds.length > slice.length) {
            info(chalk.dim(`\n(${builds.length - slice.length} more — re-run with -n ${builds.length})`));
        }
        info(chalk.dim("\nCrash details: lizard logs --restarts   Build logs: lizard logs --build"));
    });
}
//# sourceMappingURL=events.js.map