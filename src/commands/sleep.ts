import chalk from "chalk";
import { Command } from "commander";
import { api, withScope, type ResourceScope } from "../lib/api.js";
import { getActiveServiceWithKind, resolveProjectScope } from "../lib/resolve.js";
import { success, info, isJSONMode, printJSON, timeAgo } from "../lib/format.js";

export type SleepSetting = {
  enabled: boolean;
  idleMinutes: number;
  lastSleptAt: number | null;
  lastWokeAt: number | null;
  lastError: string | null;
  sleeps: number;
  wakes: number;
  restarted?: boolean;
};

/** The API path of a service's serverless setting: an app, or a managed database (addon). */
export function sleepPath(svc: { id: string; kind: "app" | "addon" }, projectId: string, scope: ResourceScope): string {
  return svc.kind === "app"
    ? withScope(`/api/apps/${svc.id}/sleep`, scope)
    : withScope(`/api/projects/${projectId}/addons/${svc.id}/sleep`, scope);
}

/** The body of a change, from --on / --off / --idle; null when only reading. */
export function sleepChange(opts: { on?: boolean; off?: boolean; idle?: number }, current?: SleepSetting): { enabled: boolean; idleMinutes?: number } | null {
  if (opts.on && opts.off) throw new Error("Pass --on or --off, not both.");
  if (opts.idle !== undefined && (!Number.isInteger(opts.idle) || opts.idle < 5 || opts.idle > 1440)) {
    throw new Error(`--idle must be whole minutes between 5 and 1440 (got ${opts.idle}).`);
  }
  if (opts.off) return { enabled: false };
  if (opts.on) return { enabled: true, ...(opts.idle !== undefined ? { idleMinutes: opts.idle } : {}) };
  // --idle alone changes the idle time of a service that already sleeps.
  if (opts.idle !== undefined) {
    if (current && !current.enabled) throw new Error("Serverless is off for this service: pass --on --idle <minutes>.");
    return { enabled: true, idleMinutes: opts.idle };
  }
  return null;
}

/**
 * `lizard sleep [service]` (alias `serverless`) — serverless, i.e. sleep when idle: with no
 * traffic for the idle time the service sleeps with its memory saved, and the next request or
 * connection wakes it in about a second. Apps with one replica and a port; Postgres and Redis.
 *   no flag   show the setting
 *   --on      turn it on (restarts the service once); --idle <minutes> 5-1440
 *   --off     always on
 */
export function registerSleep(program: Command) {
  program
    .command("sleep")
    .alias("serverless")
    .description("Serverless: sleep when idle and wake on the next request (show, --on, --off)")
    .argument("[service]", "Service name or ID (defaults to linked)")
    .option("-s, --service <name>", "Service name or ID")
    .option("-p, --project <id>", "Project name, slug, or ID")
    .option("--on", "Sleep when idle (restarts the service once)")
    .option("--off", "Always on")
    .option("--idle <minutes>", "Minutes without traffic before it sleeps (5-1440)", (v) => Number(v))
    .action(async (serviceArg: string | undefined, opts) => {
      const { projectId, scope } = await resolveProjectScope(opts.project);
      const svc = await getActiveServiceWithKind(serviceArg || opts.service, projectId);
      const path = sleepPath(svc, projectId, scope);
      const current = opts.idle !== undefined && !opts.on && !opts.off ? await api.get<SleepSetting>(path) : undefined;
      const change = sleepChange(opts, current);
      const setting = change ? await api.put<SleepSetting>(path, change) : await api.get<SleepSetting>(path);
      if (isJSONMode()) { printJSON({ id: svc.id, name: svc.name, kind: svc.kind, ...setting }); return; }
      const name = chalk.bold(svc.name);
      if (change) {
        success(setting.enabled
          ? `${name} is serverless: sleeps after ${setting.idleMinutes} min idle, wakes on the next request`
          : `${name} is always on`);
        if (setting.restarted) info(chalk.dim("  It restarted once to apply this."));
        return;
      }
      if (!setting.enabled) {
        info(`${name}: always on ${chalk.dim(`(lizard sleep ${svc.name} --on to make it serverless)`)}`);
        return;
      }
      info(`${name}: serverless, sleeps after ${setting.idleMinutes} min idle`);
      info(chalk.dim(`  slept ${setting.sleeps}×, woke ${setting.wakes}×` +
        (setting.lastSleptAt ? `, last slept ${timeAgo(setting.lastSleptAt)}` : "")));
      if (setting.lastError) info(chalk.yellow(`  Last error: ${setting.lastError}`));
    });
}
