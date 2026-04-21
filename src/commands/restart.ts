import * as p from "@clack/prompts";
import ora from "ora";
import { Command } from "commander";
import { api } from "../lib/api.js";
import { resolveProjectId } from "../lib/config.js";
import { success, isJSONMode, printJSON, isTTY } from "../lib/format.js";

export function registerRestart(program: Command) {
  program
    .command("restart")
    .argument("[id]", "App ID to restart")
    .description("Restart an app")
    .action(async (id: string | undefined) => {
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
            message: "Select app to restart",
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

      const spinner = ora("Restarting...").start();
      await api.post(`/api/apps/${id}/restart`);
      spinner.stop();

      if (isJSONMode()) {
        printJSON({ id, status: "restarting" });
      } else {
        success(`Restarting`);
      }
    });
}
