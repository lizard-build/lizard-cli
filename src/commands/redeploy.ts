import chalk from "chalk";
import ora from "ora";
import { Command } from "commander";
import { api, streamSSE } from "../lib/api.js";
import { success, info, error, isJSONMode, printJSON } from "../lib/format.js";

export function registerRedeploy(program: Command) {
  program
    .command("redeploy")
    .argument("<id>", "Service ID to redeploy")
    .description("Redeploy a service from latest build with current secrets")
    .option("--detach", "Run in background")
    .action(async (id: string, opts) => {
      const spinner = ora("Starting redeploy...").start();

      await api.post(`/api/apps/${id}/redeploy`);

      spinner.stop();

      if (opts.detach || isJSONMode()) {
        if (isJSONMode()) {
          printJSON({ id, status: "deploying" });
        } else {
          success("Redeploy started");
          info(chalk.dim(`  Check status: lizard deploy-status ${id}`));
        }
        return;
      }

      // Stream build logs if not detached
      info("Redeploying...");

      // Poll for build
      let buildId: string | null = null;
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        try {
          const app = await api.get<{ builds?: Array<{ id: string; status: string }> }>(
            `/api/apps/${id}`,
          );
          if (app.builds?.length) {
            const latest = app.builds[0];
            if (["building", "deploying", "running", "failed"].includes(latest.status)) {
              buildId = latest.id;
              break;
            }
          }
        } catch {}
      }

      if (buildId) {
        await streamSSE(`/api/builds/${buildId}/logs`, (event, data) => {
          if (event === "done" || event === "error") {
            if (event === "error") error(`Build failed: ${data}`);
            return false;
          }
          try {
            const parsed = JSON.parse(data);
            process.stdout.write((parsed.line || data) + "\n");
          } catch {
            process.stdout.write(data + "\n");
          }
          return true;
        });
      }

      const app = await api.get<{ status: string; domain?: string }>(`/api/apps/${id}`);
      if (app.status === "running") {
        success(`Redeployed! ${app.domain ? chalk.cyan(`https://${app.domain}`) : ""}`);
      } else {
        error("Redeploy failed");
      }
    });
}
