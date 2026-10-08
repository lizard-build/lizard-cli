import chalk from "chalk";
import * as p from "@clack/prompts";
import { api, withScope } from "../lib/api.js";
import { assertValidVolumeName, resolveVolume } from "../lib/volume.js";
import { resolveProjectScope } from "../lib/resolve.js";
import { success, info, warn, isJSONMode, printJSON, table, isTTY } from "../lib/format.js";
function parseIntOption(v) {
    const n = Number(v);
    if (!Number.isSafeInteger(n) || n < 1)
        throw new Error(`--size must be a positive whole number of GB (got ${v}).`);
    return n;
}
/** parseIntOption, but whole numbers only: parseInt("1.5") is 1, and a resize that
 *  silently rounds a typo down is a shrink the user never asked for. */
function parseSizeGbOption(v) {
    if (!/^\s*\d+\s*$/.test(v))
        throw new Error(`--size must be a whole number of GB (got ${v}).`);
    return parseIntOption(v);
}
export function registerVolume(program) {
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
        const volumes = await api.get(withScope(`/api/projects/${projectId}/volumes`, scope));
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
        table(["Name", "Size", "Status", "Attached to"], volumes.map((v) => [
            v.name,
            `${v.sizeGb} GB`,
            v.status,
            v.attachedTo ? chalk.dim(v.attachedTo) : chalk.dim("—"),
        ]));
    });
    vol
        .command("create")
        .argument("<name>", "Volume name")
        .description("Create a persistent volume")
        .option("--size <gb>", "Size in GB (server limits apply; default 5)", parseIntOption)
        .option("--region <code>", "Region to place the volume in (must match the sandbox that will attach it)")
        .option("-p, --project <id>", "Project name, slug, or ID")
        .action(async (name, opts) => {
        assertValidVolumeName(name);
        const { projectId, scope } = await resolveProjectScope(opts.project);
        const limits = await api.get(withScope(`/api/projects/${projectId}/volume-limits`, scope));
        const sizeGb = opts.size ?? limits.defaultSizeGb;
        if (!Number.isSafeInteger(sizeGb) || sizeGb < limits.minSizeGb || sizeGb > limits.maxSizeGb) {
            throw new Error(`--size must be between ${limits.minSizeGb} and ${limits.maxSizeGb} GB (got ${sizeGb}).`);
        }
        if (!isJSONMode())
            info(`Creating volume ${chalk.cyan(name)}...`);
        const created = await api.post(withScope(`/api/projects/${projectId}/volumes`, scope), { name, sizeGb, region: opts.region });
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
        .description("Grow or shrink a volume in place (not supported on Firecracker yet). Online: no data is copied, " +
        "and an attached sandbox keeps running and sees the new size immediately. " +
        "A shrink must leave at least 10% of the new size free.")
        .requiredOption("--size <gb>", "New size in GB (whole number; the server enforces the project's min/max)", parseSizeGbOption)
        .option("-p, --project <id>", "Project name, slug, or ID")
        .action(async (nameOrId, opts) => {
        const sizeGb = opts.size;
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
            }
            else {
                info(`Volume ${chalk.bold(volume.name)} is already ${sizeGb} GB — nothing to do.`);
            }
            return;
        }
        const resized = await api.patch(withScope(`/api/projects/${projectId}/volumes/${encodeURIComponent(volume.name)}`, scope), { sizeGb });
        if (isJSONMode()) {
            printJSON(resized);
            return;
        }
        success(`Volume ${chalk.bold(resized.name)} resized: ${volume.sizeGb} GB → ${resized.sizeGb} GB`);
        if (resized.sizeEnforced === false) {
            warn("This region's storage does not enforce volume size; the new size is recorded but not a hard limit.");
        }
    });
    vol
        .command("rm")
        .alias("delete")
        .argument("<volume>", "Volume name or ID")
        .description("Delete a volume")
        .option("-p, --project <id>", "Project name, slug, or ID")
        .option("-y, --yes", "Skip confirmation")
        .action(async (nameOrId, opts) => {
        const { projectId, scope } = await resolveProjectScope(opts.project);
        const volume = await resolveVolume(projectId, scope, nameOrId);
        if (volume.attachedTo) {
            throw new Error(`Volume "${volume.name}" is attached to sandbox ${volume.attachedTo}. Delete the sandbox first.`);
        }
        if (!opts.yes && isTTY() && !isJSONMode()) {
            const ok = await p.confirm({
                message: `Delete volume ${chalk.bold(volume.name)}? This cannot be undone.`,
            });
            if (p.isCancel(ok) || !ok)
                process.exit(5);
        }
        await api.delete(withScope(`/api/projects/${projectId}/volumes/${encodeURIComponent(volume.name)}`, scope));
        if (isJSONMode()) {
            printJSON({ id: volume.id, status: "deleted" });
        }
        else {
            success(`Volume ${chalk.bold(volume.name)} deleted`);
        }
    });
}
//# sourceMappingURL=volume.js.map