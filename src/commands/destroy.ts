import chalk from "chalk";
import * as p from "@clack/prompts";
import { Command } from "commander";
import { api } from "../lib/api.js";
import { resolveProjectId } from "../lib/config.js";
import { success, isJSONMode, printJSON, isTTY } from "../lib/format.js";

export function registerDestroy(program: Command) {
  program
    .command("destroy")
    .argument("[id]", "Service ID to destroy")
    .description("Destroy a service (irreversible)")
    .action(async (id: string | undefined) => {
      const projectId = resolveProjectId(program.opts().project);
      const yes = program.opts().yes;

      if (!id) {
        if (!isTTY()) throw new Error("Provide a service ID or run interactively");

        const data = await api.get<{ apps: any[]; addons: any[] }>(
          `/api/projects/${projectId}/services`,
        );

        const options = [
          ...(data.apps || []).map((a: any) => ({
            value: `app:${a.id}`,
            label: a.name || a.id,
            hint: `app · ${a.status}`,
          })),
          ...(data.addons || []).map((a: any) => ({
            value: `addon:${a.id}`,
            label: a.name || a.type,
            hint: `${a.type} · ${a.status}`,
          })),
        ];

        if (options.length === 0) throw new Error("No services in project");

        const selected = await p.select({
          message: "Select service to destroy",
          options,
        });
        if (p.isCancel(selected)) process.exit(5);

        const [type, selectedId] = (selected as string).split(":");
        id = selectedId;

        if (!yes) {
          const name = options.find((o) => o.value === selected)?.label || id;
          const confirm = await p.confirm({
            message: `Destroy ${chalk.bold(name)}? This is irreversible.`,
          });
          if (p.isCancel(confirm) || !confirm) process.exit(5);
        }

        if (type === "addon") {
          await api.delete(`/api/projects/${projectId}/addons/${id}`);
        } else {
          await api.delete(`/api/apps/${id}`);
        }

        if (isJSONMode()) {
          printJSON({ id, status: "destroyed" });
        } else {
          success(`Service destroyed`);
        }
        return;
      }

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
