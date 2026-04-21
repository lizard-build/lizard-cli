import chalk from "chalk";
import * as p from "@clack/prompts";
import { Command } from "commander";
import { api } from "../lib/api.js";
import { resolveProjectId } from "../lib/config.js";
import { success, isJSONMode, printJSON, isTTY } from "../lib/format.js";

export function registerDestroy(program: Command) {
  program
    .command("destroy")
    .argument("<id>", "Service ID to destroy")
    .description("Destroy a service (irreversible)")
    .action(async (id: string) => {
      const projectId = resolveProjectId(program.opts().project);
      const yes = program.opts().yes;

      if (!yes) {
        if (!isTTY()) throw new Error("Use -y to confirm destruction in non-interactive mode");
        const confirm = await p.confirm({
          message: `Destroy service ${chalk.bold(id)}? This is irreversible.`,
        });
        if (p.isCancel(confirm) || !confirm) process.exit(5);
      }

      // Try as app first, then as addon
      try {
        await api.delete(`/api/apps/${id}`);
        if (isJSONMode()) {
          printJSON({ id, status: "destroyed", type: "app" });
        } else {
          success(`Service destroyed`);
        }
        return;
      } catch (err: any) {
        if (err.status !== 404) throw err;
      }

      await api.delete(`/api/projects/${projectId}/addons/${id}`);
      if (isJSONMode()) {
        printJSON({ id, status: "destroyed", type: "addon" });
      } else {
        success(`Service destroyed`);
      }
    });
}
