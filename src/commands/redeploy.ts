import chalk from "chalk";
import ora from "ora";
import * as p from "@clack/prompts";
import { Command } from "commander";
import { api, streamSSE } from "../lib/api.js";
import { resolveProjectId } from "../lib/config.js";
import { success, info, error, isJSONMode, printJSON, isTTY } from "../lib/format.js";

export function registerRedeploy(program: Command) {
  program
    .command("redeploy")
    .argument("[id]", "App ID to redeploy")
    .description("Redeploy an app from latest build with current secrets")
    .option("--detach", "Run in background")
    .action(async (id: string | undefined, opts) => {
      if (!id) {
        if (!isTTY()) throw new Error("Provide an app ID or run interactively");

        const projectId = resolveProjectId(program.opts().project);
        const data = await api.get<{ apps: any[] }>(`/api/projects/${projectId}/services`);
        const apps = data.apps || [];

        if (apps.length === 0) throw new Error("No apps in project");

        if (apps.length === 1) {
          id = apps[0].id;
        } else {
          const selected = await p.select({
            message: "Select app to redeploy",
            options: apps.map((a: any) => ({
              value: a.id,
              label: a.name || a.id,
              hint: a.status,
            })),
          });
          if (p.isCancel(selected)) process.exit(5);
          id = selected as string;
        }
      }

      const spinner = ora("Starting redeploy...").start();
      await api.post(`/api/apps/${id}/redeploy`);
      spinner.stop();

      if (opts.detach || isJSONMode()) {
        if (isJSONMode()) {
          printJSON({ id, status: "deploying" });
        } else {
          success("Redeploy started");
          info(chalk.dim(`  Check status: lizard deploy status ${id}`));
        }
        return;
      }

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
