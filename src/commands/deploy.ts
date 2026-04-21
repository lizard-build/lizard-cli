import chalk from "chalk";
import ora from "ora";
import { Command } from "commander";
import { api, streamSSE } from "../lib/api.js";
import { resolveProjectId } from "../lib/config.js";
import {
  success,
  info,
  error,
  isJSONMode,
  printJSON,
  statusColor,
  table,
} from "../lib/format.js";

interface App {
  id: string;
  name: string;
  status: string;
  domain?: string;
  repo?: string;
  branch?: string;
  builds?: Array<{ id: string; status: string }>;
}

export function registerDeploy(program: Command) {
  program
    .command("deploy")
    .description("Deploy the current project")
    .option("--detach", "Run in background without streaming logs")
    .option("--region <region>", "Region for deployment")
    .action(async (opts) => {
      const projectId = resolveProjectId(program.opts().project);

      // Check if there's already an app, if so redeploy
      const services = await api.get<{ apps: App[] }>(
        `/api/projects/${projectId}/services`,
      );

      if (services.apps && services.apps.length > 0) {
        // Redeploy existing app
        const app = services.apps[0];
        info(`Redeploying ${chalk.bold(app.name)}...`);

        await api.post(`/api/apps/${app.id}/redeploy`);

        if (opts.detach) {
          if (isJSONMode()) {
            printJSON({ appId: app.id, status: "deploying" });
          } else {
            success(`Redeploy started for ${app.name}`);
            info(chalk.dim(`  Check status: lizard deploy status ${app.id}`));
          }
          return;
        }

        // Stream build logs
        await streamBuildLogs(app.id);
        return;
      }

      // First deploy — create app
      // TODO: detect repo from git remote, create app from repo
      throw new Error(
        "First deploy requires an existing app. Create one from the dashboard or use `lizard init` + push via git.",
      );
    });

  program
    .command("deploy-status")
    .argument("<id>", "App or deploy ID")
    .description("Show deployment status")
    .action(async (id) => {
      const app = await api.get<App>(`/api/apps/${id}`);

      if (isJSONMode()) {
        printJSON(app);
        return;
      }

      console.log(`${chalk.bold(app.name)}  ${statusColor(app.status)}`);
      if (app.domain) console.log(`  URL: ${chalk.cyan(`https://${app.domain}`)}`);
      if (app.builds?.length) {
        const latest = app.builds[0];
        console.log(`  Latest build: ${statusColor(latest.status)}`);
      }
    });
}

async function streamBuildLogs(appId: string) {
  // Wait a moment for the build to start
  const spinner = ora("Waiting for build...").start();

  // Poll until we get a build ID
  let buildId: string | null = null;
  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    try {
      const app = await api.get<App>(`/api/apps/${appId}`);
      if (app.builds?.length) {
        const latest = app.builds[0];
        if (["building", "deploying", "running", "failed"].includes(latest.status)) {
          buildId = latest.id;
          break;
        }
      }
    } catch {}
  }
  spinner.stop();

  if (!buildId) {
    info(chalk.dim("No build found. Check `lizard deploy status <id>` for status."));
    return;
  }

  info(chalk.dim("Streaming build logs...\n"));

  await streamSSE(`/api/builds/${buildId}/logs`, (event, data) => {
    if (event === "done" || event === "error") {
      if (event === "error") {
        error(`Build failed: ${data}`);
      } else {
        success("Build complete");
      }
      return false;
    }

    // Print log line
    try {
      const parsed = JSON.parse(data);
      if (parsed.line) {
        process.stdout.write(parsed.line + "\n");
      } else if (typeof parsed === "string") {
        process.stdout.write(parsed + "\n");
      }
    } catch {
      process.stdout.write(data + "\n");
    }
    return true;
  });

  // Check final status
  const app = await api.get<App>(`/api/apps/${appId}`);
  if (app.status === "running") {
    success(`Deployed! ${app.domain ? chalk.cyan(`https://${app.domain}`) : ""}`);
  } else if (app.status === "failed") {
    error("Deploy failed. Check logs with `lizard logs --build`");
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
