import chalk from "chalk";
import { Command } from "commander";
import { api } from "../lib/api.js";
import { resolveProjectId } from "../lib/config.js";
import { getActiveService } from "../lib/resolve.js";
import { success, isJSONMode, printJSON, table } from "../lib/format.js";

interface Volume {
  id: string;
  name: string;
  mountPath: string;
  sizeMb: number;
  state?: string;
}

/**
 * `lizard volume` — Railway-style volume management.
 */
export function registerVolume(program: Command) {
  const vol = program
    .command("volume")
    .alias("volumes")
    .description("Manage persistent volumes");

  vol
    .command("list")
    .alias("ls")
    .description("List volumes for a service")
    .option("-s, --service <name>", "Service name or ID")
    .option("-p, --project <id>", "Project name or ID")
    .action(async (opts) => {
      const projectId = resolveProjectId(opts.project);
      const service = await getActiveService(opts.service, projectId);

      const volumes = await api
        .get<Volume[]>(`/api/apps/${service.id}/volumes`)
        .catch(() => [] as Volume[]);

      if (isJSONMode()) {
        printJSON(volumes);
        return;
      }

      if (volumes.length === 0) {
        console.log("No volumes. Add one with `lizard volume add`.");
        return;
      }

      table(
        ["Name", "Mount", "Size (MB)", "State"],
        volumes.map((v) => [v.name, v.mountPath, String(v.sizeMb), v.state || "—"]),
      );
    });

  vol
    .command("add")
    .description("Attach a new volume to a service")
    .requiredOption("--name <name>", "Volume name")
    .requiredOption("--mount <path>", "Mount path inside the container")
    .option("--size <mb>", "Size in MB", parseIntOption, 1024)
    .option("-s, --service <name>", "Service name or ID")
    .option("-p, --project <id>", "Project name or ID")
    .action(async (opts) => {
      const projectId = resolveProjectId(opts.project);
      const service = await getActiveService(opts.service, projectId);

      const created = await api
        .post<Volume>(`/api/apps/${service.id}/volumes`, {
          name: opts.name,
          mountPath: opts.mount,
          sizeMb: opts.size,
        })
        .catch((err: any) => {
          if (err?.status === 404) {
            throw new Error(
              "Volume endpoint not yet implemented. The API needs " +
                "`POST /api/apps/{id}/volumes` with body { name, mountPath, sizeMb }.",
            );
          }
          throw err;
        });

      if (isJSONMode()) printJSON(created);
      else success(`Volume ${chalk.bold(created.name)} attached at ${created.mountPath}`);
    });

  vol
    .command("delete")
    .alias("rm")
    .argument("<name>", "Volume name or ID")
    .description("Detach and delete a volume")
    .option("-s, --service <name>", "Service name or ID")
    .option("-p, --project <id>", "Project name or ID")
    .action(async (name: string, opts) => {
      const projectId = resolveProjectId(opts.project);
      const service = await getActiveService(opts.service, projectId);

      await api
        .delete(`/api/apps/${service.id}/volumes/${encodeURIComponent(name)}`)
        .catch((err: any) => {
          if (err?.status === 404) {
            throw new Error(
              "Volume delete endpoint not yet implemented. The API needs " +
                "`DELETE /api/apps/{id}/volumes/{name}`.",
            );
          }
          throw err;
        });

      if (isJSONMode()) printJSON({ name, status: "deleted" });
      else success(`Volume ${chalk.bold(name)} deleted`);
    });
}

function parseIntOption(v: string): number {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) throw new Error(`Invalid number: ${v}`);
  return n;
}
