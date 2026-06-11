import chalk from "chalk";
import { Command } from "commander";
import { api, withQuery } from "../lib/api.js";
import { resolveProjectScope, getActiveServiceWithKind } from "../lib/resolve.js";
import { info, error, isJSONMode, printJSON, table, statusColor, timeAgo } from "../lib/format.js";

// Shape returned by /api/apps/:id/deploy-events (build-level; crash events
// per build are surfaced by `lizard logs --restarts`).
interface DeployEvent {
  buildId: string;
  trigger: string | null;
  status: string;
  commitSha: string | null;
  createdAt: number;
  events: Array<{ id: string; source: string; status: string }>;
}

interface PodStatus {
  name: string;
  phase: string;
  ready: boolean;
  restarts: number;
  reason?: string | null;
  message?: string | null;
  exitCode?: number | null;
  startedAt?: number | null;
}

export function registerEvents(program: Command) {
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
        api.get<DeployEvent[]>(`/api/apps/${svc.id}/deploy-events`),
        api
          .get<{ pods: PodStatus[] }>(`/api/apps/${svc.id}/pod-status`)
          .catch(() => ({ pods: [] as PodStatus[] })),
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
        table(
          ["Name", "Phase", "Ready", "Restarts", "Started", "Reason"],
          podStatus.pods.map((pod) => [
            pod.name,
            statusColor(pod.phase.toLowerCase()),
            pod.ready ? chalk.green("✓") : chalk.red("✗"),
            String(pod.restarts),
            pod.startedAt ? timeAgo(pod.startedAt) : chalk.dim("—"),
            pod.reason || chalk.dim("—"),
          ]),
        );
        console.log();
      }

      if (slice.length === 0) {
        info(chalk.dim(`No deploys for ${svc.name} yet.`));
        return;
      }

      console.log(chalk.bold("Deploys"));
      table(
        ["When", "Status", "Trigger", "Commit", "Restarts", "Build"],
        slice.map((b) => [
          timeAgo(b.createdAt),
          statusColor(b.status),
          b.trigger ?? chalk.dim("—"),
          b.commitSha ? b.commitSha.slice(0, 7) : chalk.dim("—"),
          b.events.length > 0 ? chalk.yellow(String(b.events.length)) : chalk.dim("0"),
          chalk.dim(b.buildId),
        ]),
      );

      if (builds.length > slice.length) {
        info(chalk.dim(`\n(${builds.length - slice.length} more — re-run with -n ${builds.length})`));
      }
      info(chalk.dim("\nCrash details: lizard logs --restarts   Build logs: lizard logs --build"));
    });
}
