import chalk from "chalk";
import * as p from "@clack/prompts";
import { Command } from "commander";
import { streamSSE, api, withScope, withQuery, type ResourceScope } from "../lib/api.js";
import { resolveProjectScope, resolveService } from "../lib/resolve.js";
import { info, error, isTTY, isJSONMode } from "../lib/format.js";

export function registerLogs(program: Command) {
  program
    .command("logs")
    .description("Stream runtime logs")
    .option("--build", "Show build logs instead of runtime")
    .option("-s, --service <id>", "Only show logs for a specific service")
    .option("-p, --project <id>", "Project name, slug, or ID")
    .option("--tail <n>", "Print last N log lines and exit (no follow)")
    .action(async (opts) => {
      const { projectId, scope } = await resolveProjectScope(opts.project);

      const tailN = opts.tail !== undefined ? parseTail(opts.tail) : undefined;

      if (opts.build) {
        await showBuildLogs(opts.service, projectId, scope, tailN);
        return;
      }

      // Resolve -s flag (may be name, slug, or ID) once up front so every
      // branch below talks to the API with a real service ID.
      let serviceId: string | undefined;
      if (opts.service) {
        const svc = await resolveService(projectId, opts.service);
        serviceId = svc.id;
      }

      // --tail: fetch historical logs and exit
      if (tailN !== undefined) {
        const entries = await api.get<any[]>(
          withScope(
            withQuery(`/api/projects/${projectId}/logs`, {
              limit: tailN,
              service: serviceId,
            }),
            scope,
          ),
        );
        for (const e of entries) printLogEntry(e);
        return;
      }

      if (!serviceId && isTTY() && !isJSONMode()) {
        // Offer to pick a specific service or stream all
        const data = await api.get<{ apps: any[] }>(
          withScope(`/api/projects/${projectId}/services`, scope),
        );
        const apps = data.apps || [];

        if (apps.length > 1) {
          const choices = [
            { value: "all", label: "All services", hint: "stream combined logs" },
            ...apps.map((a: any) => ({
              value: a.id,
              label: a.name || a.id,
              hint: a.status,
            })),
          ];
          const selected = await p.select({ message: "Show logs for", options: choices });
          if (p.isCancel(selected)) process.exit(5);
          if (selected !== "all") serviceId = selected as string;
        }
      }

      if (serviceId) {
        // Stream logs for a specific app
        info(chalk.dim("Streaming logs... (Ctrl+C to stop)\n"));
        await streamSSE(`/api/apps/${serviceId}/logs`, (event, data) => {
          if (event === "error") {
            error(data);
            return false;
          }
          printLogLine(data);
          return true;
        });
        return;
      }

      // Stream all project logs
      info(chalk.dim("Streaming project logs... (Ctrl+C to stop)\n"));
      await streamSSE(
        withScope(`/api/projects/${projectId}/logs/stream`, scope),
        (event, data) => {
          if (event === "error") {
            error(data);
            return false;
          }
          printLogLine(data);
          return true;
        },
      );
    });
}

function parseTail(raw: string): number {
  const n = parseInt(raw, 10);
  if (isNaN(n) || n < 1) {
    error("--tail must be a positive integer");
    process.exit(1);
  }
  if (n > 1000) {
    info(chalk.yellow("--tail capped at 1000 (server limit)"));
    return 1000;
  }
  return n;
}

function replicaPrefix(e: any): string {
  if (!e.replica) return "";
  return chalk.magenta(`[${e.replica}]`) + " ";
}

function printLogEntry(e: any) {
  if (isJSONMode()) {
    process.stdout.write(JSON.stringify(e) + "\n");
    return;
  }
  const rep = replicaPrefix(e);
  if (e.service && e.message) {
    const prefix = chalk.cyan(`[${e.service}]`);
    process.stdout.write(`${prefix} ${rep}${e.message}\n`);
  } else if (e.message) {
    process.stdout.write(`${rep}${e.message}\n`);
  }
}

function printLogLine(data: string) {
  let parsed: any;
  try {
    parsed = JSON.parse(data);
  } catch {
    parsed = { message: data };
  }
  if (typeof parsed === "string") parsed = { message: parsed };

  if (isJSONMode()) {
    process.stdout.write(JSON.stringify(parsed) + "\n");
    return;
  }

  const rep = replicaPrefix(parsed);
  if (parsed.service && parsed.message) {
    const prefix = chalk.cyan(`[${parsed.service}]`);
    process.stdout.write(`${prefix} ${rep}${parsed.message}\n`);
  } else if (parsed.message) {
    process.stdout.write(`${rep}${parsed.message}\n`);
  } else {
    process.stdout.write(data + "\n");
  }
}

async function showBuildLogs(
  serviceRef: string | undefined,
  projectId: string,
  scope: ResourceScope,
  tailN?: number,
) {
  let appId: string | undefined;
  if (serviceRef) {
    const svc = await resolveService(projectId, serviceRef);
    appId = svc.id;
  }

  if (!appId) {
    // Get first app in project
    const data = await api.get<{ apps: Array<{ id: string; name: string }> }>(
      withScope(`/api/projects/${projectId}/services`, scope),
    );
    if (!data.apps?.length) {
      throw new Error(
        "No apps in project. Create one with `lizard up` or `lizard add`.",
      );
    }
    appId = data.apps[0].id;
  }

  // Get latest build
  const app = await api.get<{
    builds?: Array<{ id: string; status: string }>;
  }>(`/api/apps/${appId}`);
  if (!app.builds?.length) {
    throw new Error(
      "No builds for this app yet. Trigger one with `lizard up` or `lizard redeploy`.",
    );
  }

  const buildId = app.builds[0].id;
  info(chalk.dim(`Build ${buildId}\n`));

  if (tailN !== undefined) {
    const lines: string[] = [];
    await streamSSE(`/api/builds/${buildId}/logs`, (event, data) => {
      if (event === "done" || event === "error") return false;
      lines.push(data);
      return true;
    });
    for (const line of lines.slice(-tailN)) printLogLine(line);
    return;
  }

  await streamSSE(`/api/builds/${buildId}/logs`, (event, data) => {
    if (event === "done" || event === "error") {
      return false;
    }
    printLogLine(data);
    return true;
  });
}
