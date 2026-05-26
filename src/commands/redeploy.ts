import chalk from "chalk";
import ora from "ora";
import * as p from "@clack/prompts";
import { Command } from "commander";
import { api, streamSSE, withScope } from "../lib/api.js";
import { resolveProjectScope, resolveService } from "../lib/resolve.js";
import { success, info, error, isJSONMode, printJSON, isTTY } from "../lib/format.js";

export function registerRedeploy(program: Command) {
  program
    .command("redeploy")
    .argument("[nameOrId]", "App name or ID to redeploy")
    .description("Trigger a fresh build (latest commit / last upload) with current vars")
    .option("--detach", "Run in background")
    .option("-s, --service <name>", "App name or ID (alias for positional)")
    .option("-p, --project <id>", "Project name, slug, or ID")
    .action(async (nameOrId: string | undefined, opts) => {
      const ref = nameOrId || opts.service;
      let id: string | undefined;
      if (ref) {
        const { projectId } = await resolveProjectScope(opts.project);
        const resolved = await resolveService(projectId, ref);
        if (resolved.kind !== "app") {
          throw new Error(`"${ref}" is not an app`);
        }
        id = resolved.id;
      } else {
        if (!isTTY()) throw new Error("Provide an app name or ID, or run interactively");

        const { projectId, scope } = await resolveProjectScope(opts.project);
        const data = await api.get<{ apps: any[] }>(withScope(`/api/projects/${projectId}/services`, scope));
        const apps = data.apps || [];

        if (apps.length === 0) {
          throw new Error(
            "No apps in project. Create one with `lizard up` or `lizard add`.",
          );
        }

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
            const line =
              typeof parsed === "string" ? parsed : (parsed.line ?? data);
            process.stdout.write(line + "\n");
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
