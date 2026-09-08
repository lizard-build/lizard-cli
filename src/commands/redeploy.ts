import chalk from "chalk";
import ora from "ora";
import * as p from "@clack/prompts";
import { Command } from "commander";
import { api, streamSSE, withScope } from "../lib/api.js";
import { resolveProjectScope, resolveService } from "../lib/resolve.js";
import { success, info, error, isJSONMode, printJSON, isTTY, fail } from "../lib/format.js";
import { waitForAppReady } from "../lib/wait-ready.js";

export function registerRedeploy(program: Command) {
  program
    .command("redeploy")
    .argument("[nameOrId]", "App name or ID to redeploy")
    .description("Trigger a fresh build (latest commit / last upload) with current vars")
    .option("--detach", "Run in background")
    .option(
      "--wait",
      "Wait for the new build to deploy and become ready before exiting (works in --json mode too)",
    )
    .option("--timeout <seconds>", "Max time to wait with --wait, in seconds", "120")
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
        const { projectId, scope } = await resolveProjectScope(opts.project);
        const data = await api.get<{ apps: any[] }>(withScope(`/api/projects/${projectId}/services`, scope));
        const apps = data.apps || [];

        if (apps.length === 0) {
          throw new Error(
            "No apps in project. Create one with `lizard up` or `lizard add`.",
          );
        }

        if (apps.length === 1) {
          // Only one app — no ambiguity, resolve it regardless of TTY so
          // scripted/non-interactive callers don't need to pass a redundant name.
          id = apps[0].id;
        } else if (isTTY()) {
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
        } else {
          throw new Error("Multiple apps — provide an app name or ID, or run interactively");
        }
      }

      const timeoutSeconds = parseInt(opts.timeout, 10);
      if (!(timeoutSeconds > 0)) {
        fail(`--timeout must be a positive number of seconds, got ${JSON.stringify(opts.timeout)}`, 1, "INVALID_ARGUMENT");
      }
      const timeoutMs = timeoutSeconds * 1000;

      const spinner = ora("Starting redeploy...").start();
      // The endpoint pre-creates and returns the Build record — use its id
      // instead of polling builds[0], which races against a previous build.
      const build = await api.post<{ id?: string; status?: string }>(
        `/api/apps/${id}/redeploy`,
        undefined,
        { "X-Deploy-Source": "cli" },
      );
      spinner.stop();

      if (!opts.wait && (opts.detach || isJSONMode())) {
        if (isJSONMode()) {
          printJSON({ id, buildId: build?.id, status: "deploying" });
        } else {
          success("Redeploy started");
          info(chalk.dim(`  Check status: lizard up status ${id}`));
        }
        return;
      }

      const jsonWait = opts.wait && isJSONMode();
      if (!jsonWait) info("Redeploying...");

      let buildId: string | null = build?.id ?? null;
      // Fallback for older servers that respond without a Build record.
      for (let i = 0; !buildId && i < 30; i++) {
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

      let buildFailed = false;
      let buildFailReason: string | undefined;
      if (buildId) {
        await streamSSE(`/api/builds/${buildId}/logs`, (event, data) => {
          if (event === "done" || event === "error") {
            if (event === "error") {
              buildFailed = true;
              buildFailReason = data;
              if (!jsonWait) error(`Build failed: ${data}`);
            }
            return false;
          }
          if (jsonWait) return true; // suppress raw log lines in JSON mode
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

      if (opts.wait) {
        if (buildFailed) {
          if (isJSONMode()) {
            printJSON({ id, buildId, ok: false, status: "build_failed", reason: buildFailReason });
          } else {
            error(`Redeploy failed: ${buildFailReason ?? "build failed"}`);
          }
          process.exitCode = 1;
          return;
        }
        // Build succeeded — deployStatus is already deploying/idle by this point
        // (streamSSE only returns after the build's done/error frame), so trust
        // status/deployStatus transitions directly rather than gating on
        // restartedAt (redeploy never touches it — see waitForAppReady's doc).
        const waitSpinner = isJSONMode() ? null : ora("Waiting for the new build to become ready...").start();
        const result = await waitForAppReady(id!, undefined, { timeoutMs });
        waitSpinner?.stop();

        if (isJSONMode()) {
          printJSON({ id, buildId, ...result });
        } else if (result.ok) {
          success(`Redeployed! ${result.domain ? chalk.cyan(`https://${result.domain}`) : ""}`);
        } else {
          error(
            result.status === "timeout"
              ? `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for the deploy to become ready`
              : `Redeploy failed (${result.status})`,
          );
        }
        if (!result.ok) process.exitCode = 1;
        return;
      }

      const app = await api.get<{ status: string; domain?: string }>(`/api/apps/${id}`);
      if (app.status === "running") {
        success(`Redeployed! ${app.domain ? chalk.cyan(`https://${app.domain}`) : ""}`);
      } else {
        error("Redeploy failed");
        process.exitCode = 1;
      }
    });
}
