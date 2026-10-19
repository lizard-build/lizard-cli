import chalk from "chalk";
import * as p from "@clack/prompts";
import { Command } from "commander";
import { api, withScope, type ResourceScope } from "../lib/api.js";
import { assertValidVolumeName, resolveVolume, type VolumeRecord } from "../lib/volume.js";
import { resolveProjectScope, resolveService } from "../lib/resolve.js";
import { success, info, warn, isJSONMode, printJSON, table, isTTY } from "../lib/format.js";

function parseIntOption(v: string): number {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`--size must be a positive whole number of GB (got ${v}).`);
  return n;
}

/** parseIntOption, but whole numbers only: parseInt("1.5") is 1, and a resize that
 *  silently rounds a typo down is a shrink the user never asked for. */
function parseSizeGbOption(v: string): number {
  if (!/^\s*\d+\s*$/.test(v)) throw new Error(`--size must be a whole number of GB (got ${v}).`);
  return parseIntOption(v);
}

interface ServiceVolume { id: string; name: string; sizeGb: number; mountPath?: string | null; status: string }

/** The app a --service flag names; volumes attach to apps, not addons. */
async function serviceApp(projectId: string, nameOrId: string) {
  const svc = await resolveService(projectId, nameOrId);
  if (svc.kind !== "app") throw new Error(`${svc.name} is a managed addon; its storage is managed for you.`);
  return svc;
}

export function registerVolume(program: Command) {
  const vol = program
    .command("volume")
    .alias("vol")
    .description("Manage persistent volumes for sandboxes and services");

  vol
    .command("list")
    .alias("ls")
    .description("List volumes in a project (sandbox volumes), or a service's volume with --service")
    .option("-s, --service <name>", "List the volume attached to this service")
    .option("-p, --project <id>", "Project name, slug, or ID")
    .action(async (opts) => {
      const { projectId, scope } = await resolveProjectScope(opts.project);
      if (opts.service) {
        const app = await serviceApp(projectId, opts.service);
        const attached = await api.get<ServiceVolume[]>(`/api/apps/${app.id}/volumes`);
        if (isJSONMode()) return printJSON(attached);
        if (!attached.length) return console.log(`${app.name} has no volume. Add one: lizard volume create data --service ${app.name}`);
        table(["Name", "Size", "Mounted at", "Status"], attached.map((v) => [v.name, `${v.sizeGb} GB`, v.mountPath ?? "—", v.status]));
        return;
      }
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

      // The name is the key now — the ID is noise in a human-readable list and is
      // still there in full under `--json`.
      table(
        ["Name", "Size", "Status", "Attached to"],
        volumes.map((v) => [
          v.name,
          `${v.sizeGb} GB`,
          v.status,
          v.attachedTo ? chalk.dim(v.attachedTo) : chalk.dim("—"),
        ]),
      );
    });

  vol
    .command("create")
    .argument("<name>", "Volume name")
    .description("Create a persistent volume for sandboxes, or create one and attach it to a service with --service")
    .option("--size <gb>", "Size in GB (server limits apply; default 5)", parseIntOption)
    .option("--region <code>", "Region to place the volume in (must match the sandbox that will attach it)")
    .option("-s, --service <name>", "Attach it to this service instead (one volume per service; files there survive restarts and redeploys)")
    .option("--mount-path <path>", "With --service: where the service sees it (default /data)")
    .option("-p, --project <id>", "Project name, slug, or ID")
    .action(async (name: string, opts) => {
      assertValidVolumeName(name);
      const { projectId, scope } = await resolveProjectScope(opts.project);
      if (opts.service) {
        const app = await serviceApp(projectId, opts.service);
        const mountPath: string = opts.mountPath ?? "/data";
        if (!mountPath.startsWith("/")) throw new Error(`--mount-path must be an absolute path (got ${mountPath}).`);
        if (!isJSONMode()) info(`Creating volume ${chalk.cyan(name)} on ${chalk.cyan(app.name)} at ${mountPath}...`);
        const created = await api.post<ServiceVolume>(`/api/apps/${app.id}/volumes`, { name, sizeGb: opts.size ?? 5, mountPath });
        if (isJSONMode()) return printJSON(created);
        success(`Volume ${chalk.bold(created.name)} (${created.sizeGb} GB) attached to ${app.name} at ${created.mountPath ?? mountPath}`);
        info(chalk.dim("  The service restarts with it mounted. Keep files you must not lose under that path."));
        return;
      }
      const limits = await api.get<{ minSizeGb: number; maxSizeGb: number; defaultSizeGb: number }>(
        withScope(`/api/projects/${projectId}/volume-limits`, scope),
      );
      const sizeGb = opts.size ?? limits.defaultSizeGb;
      if (!Number.isSafeInteger(sizeGb) || sizeGb < limits.minSizeGb || sizeGb > limits.maxSizeGb) {
        throw new Error(`--size must be between ${limits.minSizeGb} and ${limits.maxSizeGb} GB (got ${sizeGb}).`);
      }

      if (!isJSONMode()) info(`Creating volume ${chalk.cyan(name)}...`);
      const created = await api.post<VolumeRecord>(
        withScope(`/api/projects/${projectId}/volumes`, scope),
        { name, sizeGb, region: opts.region },
      );

      if (isJSONMode()) {
        printJSON(created);
        return;
      }
      success(`Volume ${chalk.bold(created.name)} created (${created.sizeGb} GB)`);
      info(chalk.dim(`  Attach it to a sandbox: lizard sandbox create --volume ${created.name}`));
    });

  vol
    .command("resize")
    .argument("<volume>", "Volume name or ID")
    .description(
      "Grow a volume in place. Online: no data is copied, and an attached sandbox keeps running " +
        "and sees the new size. A volume cannot shrink, except an older one, which can if at " +
        "least 10% of the new size stays free.",
    )
    .requiredOption("--size <gb>", "New size in GB (whole number; the server enforces the project's min/max)", parseSizeGbOption)
    .option("-p, --project <id>", "Project name, slug, or ID")
    .action(async (nameOrId: string, opts) => {
      const sizeGb: number = opts.size;
      if (!Number.isInteger(sizeGb) || sizeGb < 1) {
        throw new Error(`--size must be a whole number of GB, at least 1 (got ${opts.size}).`);
      }
      // No client-side upper bound: the limit is per-platform config (volume-limits),
      // and the server reports it in its error when exceeded.
      const { projectId, scope } = await resolveProjectScope(opts.project);
      const volume = await resolveVolume(projectId, scope, nameOrId);

      if (volume.sizeGb === sizeGb) {
        if (isJSONMode()) {
          printJSON(volume);
        } else {
          info(`Volume ${chalk.bold(volume.name)} is already ${sizeGb} GB — nothing to do.`);
        }
        return;
      }

      // sizeEnforced comes from Kubernetes volumes, grownInSandbox from Firecracker ones.
      const resized = await api.patch<VolumeRecord & { sizeEnforced?: boolean; grownInSandbox?: boolean }>(
        withScope(`/api/projects/${projectId}/volumes/${encodeURIComponent(volume.name)}`, scope),
        { sizeGb },
      );

      if (isJSONMode()) {
        printJSON(resized);
        return;
      }
      success(`Volume ${chalk.bold(resized.name)} resized: ${volume.sizeGb} GB → ${resized.sizeGb} GB`);
      if (resized.sizeEnforced === false) {
        warn("This region's storage does not enforce volume size; the new size is recorded but not a hard limit.");
      }
      const attachedTo = resized.attachedTo ?? volume.attachedTo;
      if (resized.grownInSandbox === false && attachedTo) {
        warn(
          `The disk grew, but the file system in sandbox ${attachedTo} still shows the old size. ` +
            "It grows the next time a sandbox mounts the volume.",
        );
      }
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

      await api.delete(withScope(`/api/projects/${projectId}/volumes/${encodeURIComponent(volume.name)}`, scope));

      if (isJSONMode()) {
        printJSON({ id: volume.id, status: "deleted" });
      } else {
        success(`Volume ${chalk.bold(volume.name)} deleted`);
      }
    });
}
