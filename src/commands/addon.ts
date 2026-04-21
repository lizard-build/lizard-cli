import chalk from "chalk";
import * as p from "@clack/prompts";
import { Command } from "commander";
import { api } from "../lib/api.js";
import { resolveProjectId } from "../lib/config.js";
import { success, isJSONMode, printJSON, table, statusColor, isTTY } from "../lib/format.js";

interface Addon {
  id: string;
  name: string;
  type: string;
  status: string;
  hostname?: string;
  connectionString?: string;
  envVars?: Record<string, string>;
}

export function registerAddon(program: Command) {
  const addon = program.command("addon").description("Manage addons");

  addon
    .command("list")
    .description("List addons in the project")
    .action(async () => {
      const projectId = resolveProjectId(program.opts().project);
      const data = await api.get<{ addons: Addon[] }>(`/api/projects/${projectId}/services`);
      const addons = data.addons || [];

      if (isJSONMode()) {
        printJSON(addons);
        return;
      }

      if (addons.length === 0) {
        console.log("No addons. Use `lizard add` to create one.");
        return;
      }

      table(
        ["Name", "Type", "Status", "Host"],
        addons.map((a) => [
          a.name || a.type,
          a.type,
          statusColor(a.status),
          a.hostname || chalk.dim("—"),
        ]),
      );
    });

  addon
    .command("remove")
    .argument("[id]", "Addon ID to remove")
    .description("Remove an addon from the project")
    .action(async (id: string | undefined) => {
      const projectId = resolveProjectId(program.opts().project);
      const yes = program.opts().yes;

      if (!id) {
        if (!isTTY()) throw new Error("Provide an addon ID or run interactively");

        const data = await api.get<{ addons: Addon[] }>(`/api/projects/${projectId}/services`);
        const addons = data.addons || [];

        if (addons.length === 0) throw new Error("No addons in project");

        const selected = await p.select({
          message: "Select addon to remove",
          options: addons.map((a) => ({
            value: a.id,
            label: a.name || a.type,
            hint: `${a.type} · ${a.status}`,
          })),
        });
        if (p.isCancel(selected)) process.exit(5);
        id = selected as string;
      }

      if (!yes) {
        const confirm = await p.confirm({
          message: `Remove addon ${chalk.bold(id)}? This will delete all data.`,
        });
        if (p.isCancel(confirm) || !confirm) process.exit(5);
      }

      await api.delete(`/api/projects/${projectId}/addons/${id}`);

      if (isJSONMode()) {
        printJSON({ id, status: "removed" });
      } else {
        success(`Addon removed`);
      }
    });
}
