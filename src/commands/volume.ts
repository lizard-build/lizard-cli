import chalk from "chalk";
import * as p from "@clack/prompts";
import { Command } from "commander";
import { api, withScope, type ResourceScope } from "../lib/api.js";
import { resolveProjectScope } from "../lib/resolve.js";
import { success, info, isJSONMode, printJSON, table, isTTY } from "../lib/format.js";

interface VolumeRecord {
  id: string;
  name: string;
  sizeGb: number;
  status: string;
  attachedTo?: string | null;
  createdAt?: number;
}

/** Resolve a volume by name or ID within a project. Mirrors resolveService. */
async function resolveVolume(
  projectId: string,
  scope: ResourceScope,
  nameOrId: string,
): Promise<VolumeRecord> {
  const volumes = await api.get<VolumeRecord[]>(
    withScope(`/api/projects/${projectId}/volumes`, scope),
  );
  const lower = nameOrId.toLowerCase();
  const match = volumes.find(
    (v) => v.id.toLowerCase() === lower || v.name.toLowerCase() === lower,
  );
  if (!match) {
    throw new Error(
      `Volume "${nameOrId}" not found. Available: ${volumes.map((v) => v.name).join(", ") || "(none)"}`,
    );
  }
  return match;
}

function parseIntOption(v: string): number {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) throw new Error(`Invalid number: ${v}`);
  return n;
}

export function registerVolume(program: Command) {
  const vol = program
    .command("volume")
    .alias("vol")
    .description("Manage persistent volumes for sandboxes");

  vol
    .command("list")
    .alias("ls")
    .description("List volumes in a project")
    .option("-p, --project <id>", "Project name, slug, or ID")
    .action(async (opts) => {
      const { projectId, scope } = await resolveProjectScope(opts.project);
      const volumes = await api.get<VolumeRecord[]>(
        withScope(`/api/projects/${projectId}/volumes`, scope),
      );

      if (isJSONMode()) {
        printJSON(volumes);
        return;
      }

      if (volumes.length === 0) {
        console.log("No volumes. Use `lizard volume create <name>`.");
        return;
      }

      table(
        ["Name", "ID", "Size", "Status", "Attached to"],
        volumes.map((v) => [
          v.name,
          chalk.dim(v.id),
          `${v.sizeGb} GB`,
          v.status,
          v.attachedTo ? chalk.dim(v.attachedTo) : chalk.dim("—"),
        ]),
      );
    });

  vol
    .command("create")
    .argument("<name>", "Volume name")
    .description("Create a persistent volume")
    .option("--size <gb>", "Size in GB (1-100, default 5)", parseIntOption)
    .option("-p, --project <id>", "Project name, slug, or ID")
    .action(async (name: string, opts) => {
      const { projectId, scope } = await resolveProjectScope(opts.project);
      const sizeGb = opts.size ?? 5;
      if (sizeGb < 1 || sizeGb > 100) {
        throw new Error(`--size must be between 1 and 100 (got ${sizeGb}).`);
      }

      if (!isJSONMode()) info(`Creating volume ${chalk.cyan(name)}...`);
      const created = await api.post<VolumeRecord>(
        withScope(`/api/projects/${projectId}/volumes`, scope),
        { name, sizeGb },
      );

      if (isJSONMode()) {
        printJSON(created);
        return;
      }
      success(`Volume ${chalk.bold(created.name)} created (${created.sizeGb} GB)`);
      info(chalk.dim(`  ID: ${created.id}`));
      info(chalk.dim(`  Attach it to a sandbox: lizard sandbox create --volume ${created.id}`));
    });

  vol
    .command("rm")
    .alias("delete")
    .argument("<volume>", "Volume name or ID")
    .description("Delete a volume")
    .option("-p, --project <id>", "Project name, slug, or ID")
    .option("-y, --yes", "Skip confirmation")
    .action(async (nameOrId: string, opts) => {
      const { projectId, scope } = await resolveProjectScope(opts.project);
      const volume = await resolveVolume(projectId, scope, nameOrId);

      if (volume.attachedTo) {
        throw new Error(
          `Volume "${volume.name}" is attached to sandbox ${volume.attachedTo}. Delete the sandbox first.`,
        );
      }

      if (!opts.yes && isTTY() && !isJSONMode()) {
        const ok = await p.confirm({
          message: `Delete volume ${chalk.bold(volume.name)}? This cannot be undone.`,
        });
        if (p.isCancel(ok) || !ok) process.exit(5);
      }

      await api.delete(withScope(`/api/projects/${projectId}/volumes/${volume.id}`, scope));

      if (isJSONMode()) {
        printJSON({ id: volume.id, status: "deleted" });
      } else {
        success(`Volume ${chalk.bold(volume.name)} deleted`);
      }
    });
}
