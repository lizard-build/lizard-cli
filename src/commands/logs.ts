import chalk from "chalk";
import { Command } from "commander";
import { streamSSE, api } from "../lib/api.js";
import { resolveProjectId } from "../lib/config.js";
import { info, error } from "../lib/format.js";

export function registerLogs(program: Command) {
  program
    .command("logs")
    .description("Stream runtime logs")
    .option("--build", "Show build logs instead of runtime")
    .option("--service <id>", "Only show logs for a specific service")
    .action(async (opts) => {
      const projectId = resolveProjectId(program.opts().project);

      if (opts.build) {
        // Show build logs for the latest build
        await showBuildLogs(opts.service, projectId);
        return;
      }

      if (opts.service) {
        // Stream logs for a specific app
        info(chalk.dim("Streaming logs... (Ctrl+C to stop)\n"));
        await streamSSE(`/api/apps/${opts.service}/logs`, (event, data) => {
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
        `/api/projects/${projectId}/logs/stream`,
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

function printLogLine(data: string) {
  try {
    const parsed = JSON.parse(data);
    if (parsed.service && parsed.line) {
      const prefix = chalk.cyan(`[${parsed.service}]`);
      process.stdout.write(`${prefix} ${parsed.line}\n`);
    } else if (parsed.line) {
      process.stdout.write(parsed.line + "\n");
    } else if (parsed.message) {
      process.stdout.write(parsed.message + "\n");
    } else if (typeof parsed === "string") {
      process.stdout.write(parsed + "\n");
    } else {
      process.stdout.write(data + "\n");
    }
  } catch {
    process.stdout.write(data + "\n");
  }
}

async function showBuildLogs(serviceId: string | undefined, projectId: string) {
  let appId = serviceId;

  if (!appId) {
    // Get first app in project
    const data = await api.get<{ apps: Array<{ id: string; name: string }> }>(
      `/api/projects/${projectId}/services`,
    );
    if (!data.apps?.length) {
      throw new Error("No apps in project");
    }
    appId = data.apps[0].id;
  }

  // Get latest build
  const app = await api.get<{
    builds?: Array<{ id: string; status: string }>;
  }>(`/api/apps/${appId}`);
  if (!app.builds?.length) {
    throw new Error("No builds found");
  }

  const buildId = app.builds[0].id;
  info(chalk.dim(`Build ${buildId}\n`));

  await streamSSE(`/api/builds/${buildId}/logs`, (event, data) => {
    if (event === "done" || event === "error") {
      return false;
    }
    printLogLine(data);
    return true;
  });
}
