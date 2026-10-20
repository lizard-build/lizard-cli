import chalk from "chalk";
import * as p from "@clack/prompts";
import { api, withQuery } from "../lib/api.js";
import { fetchWorkspaces, resolveWorkspace } from "../lib/picker.js";
import { isJSONMode, printJSON, table, success, info, isTTY } from "../lib/format.js";
import { printBulkResult } from "./pause.js";
export const RESALE_FIELDS = [
    { key: "cpu", flag: "cpu", label: "CPU" },
    { key: "memory", flag: "memory", label: "Memory" },
    { key: "storage", flag: "storage", label: "Volumes" },
    { key: "egress", flag: "egress", label: "Egress" },
    { key: "objectStorage", flag: "objectStorage", label: "Object storage" },
    { key: "sandbox", flag: "sandbox", label: "Sandboxes" },
];
/**
 * The multipliers to save: the current ones with the given flags changed (`--all` first,
 * then each resource flag). Null when no flag was given (show only).
 */
export function mergeResale(current, opts) {
    const parse = (name, raw) => {
        const n = Number(raw);
        if (raw.trim() === "" || !Number.isFinite(n) || n < 1 || n > 100) {
            throw new Error(`--${name.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())}: a number from 1 to 100 (1 = Lizard's price), got "${raw}"`);
        }
        return n;
    };
    let changed = false;
    const next = { ...current };
    if (opts.all !== undefined) {
        const n = parse("all", opts.all);
        for (const f of RESALE_FIELDS)
            next[f.key] = n;
        changed = true;
    }
    for (const f of RESALE_FIELDS) {
        const raw = opts[f.flag];
        if (raw !== undefined) {
            next[f.key] = parse(f.flag, raw);
            changed = true;
        }
    }
    return changed ? next : null;
}
function printResale(workspace, r) {
    if (!r.enabled) {
        info(`Workspace ${chalk.bold(workspace.name)}: no resale prices. Its scoped API keys see Lizard's prices.`);
        return;
    }
    info(`Workspace ${chalk.bold(workspace.name)}: API keys scoped to it see these multiples of Lizard's prices.`);
    table(["Resource", "Multiplier"], RESALE_FIELDS.map((f) => [f.label, `${r.multipliers[f.key]}x`]));
    info(chalk.dim("  Your own dashboard, keys with no scopes and your bill keep Lizard's prices."));
}
/** "4GB", "512mb", "2048" (MB) or "none" -> MB, or null for no limit. */
export function parseMemoryLimit(raw) {
    const v = raw.trim().toLowerCase();
    if (v === "none")
        return null;
    const m = /^(\d+(?:\.\d+)?)\s*(gb|gib|g|mb|mib|m)?$/.exec(v);
    if (!m)
        throw new Error(`--memory: a size like 4GB or 512MB (or none), got "${raw}"`);
    const n = Number(m[1]) * (m[2]?.startsWith("g") ? 1024 : 1);
    return Math.round(n);
}
/** "20GB", "500MB", "1TB", "50" (GB) or "none" -> GB, or null for no limit. */
export function parseDiskLimit(raw) {
    const v = raw.trim().toLowerCase();
    if (v === "none")
        return null;
    const m = /^(\d+(?:\.\d+)?)\s*(tb|tib|t|gb|gib|g|mb|mib|m)?$/.exec(v);
    if (!m)
        throw new Error(`--disk: a size like 20GB, 500MB or 1TB (or none), got "${raw}"`);
    const unit = m[2]?.[0] ?? "g";
    const gb = Number(m[1]) * (unit === "t" ? 1024 : unit === "m" ? 1 / 1024 : 1);
    return Math.round(gb * 1000) / 1000;
}
/** The body for PUT /limits from the flags given; null when none was given (show only). */
export function limitsBody(opts) {
    const body = {};
    const num = (flag, raw, integer) => {
        if (raw.trim().toLowerCase() === "none")
            return null;
        const n = Number(raw);
        if (raw.trim() === "" || !Number.isFinite(n) || n < 0 || (integer && !Number.isInteger(n))) {
            throw new Error(`--${flag}: ${integer ? "a whole number" : "a number"} (or none), got "${raw}"`);
        }
        return n;
    };
    if (opts.sandboxes !== undefined)
        body.maxRunningSandboxes = num("sandboxes", opts.sandboxes, true);
    if (opts.cpu !== undefined)
        body.maxCpuVcpus = num("cpu", opts.cpu, false);
    if (opts.memory !== undefined)
        body.maxMemoryMb = parseMemoryLimit(opts.memory);
    if (opts.disk !== undefined)
        body.maxDiskGb = parseDiskLimit(opts.disk);
    return Object.keys(body).length ? body : null;
}
function printLimits(workspace, l, u) {
    const cap = (v, unit = "") => (v === null ? chalk.dim("no limit") : `${v}${unit}`);
    info(`Workspace ${chalk.bold(workspace.name)}`);
    table(["", "In use now", "Limit"], [
        ["Sandboxes running", String(u.runningSandboxes), cap(l.maxRunningSandboxes)],
        ["CPU (apps + databases)", `${u.cpuVcpus.toFixed(2)} vCPU`, cap(l.maxCpuVcpus, " vCPU")],
        ["Memory (apps + databases)", `${Math.round(u.memoryMb)} MB`, cap(l.maxMemoryMb, " MB")],
        ["SSD (data written)", `${(u.diskGb ?? 0).toFixed(2)} GB`, cap(l.maxDiskGb ?? null, " GB")],
    ]);
    info(chalk.dim("  CPU and memory are what services use right now; at a limit nothing new starts there (running ones keep going)."));
    info(chalk.dim("  SSD is what databases and volumes hold; at the limit no new volume, database or volume growth (data stays)."));
}
/**
 * `lizard workspace` — create, list, and delete workspaces.
 *
 * Delete only removes empty workspaces (no projects, no sandboxes). `resale-pricing` sets the
 * prices a workspace's scoped keys are shown (a reseller's users). Member
 * management (invite/remove/rename) intentionally lives in the dashboard, not
 * here, to keep the CLI surface narrow (Railway model).
 */
export function registerWorkspace(program) {
    const ws = program
        .command("workspace")
        .description("Create, list, and delete workspaces");
    ws.command("create")
        .argument("<name>", "Workspace name")
        .description("Create a new workspace")
        .action(async (name) => {
        const workspace = await api.post("/api/workspaces", { name });
        if (isJSONMode()) {
            printJSON(workspace);
            return;
        }
        success(`Workspace ${chalk.bold(workspace.name)} created`);
        info(chalk.dim(`  Slug: ${workspace.slug}`));
        info(chalk.dim(`  Add a project: lizard project create <name> --workspace ${workspace.slug}`));
    });
    ws.command("list")
        .alias("ls")
        .description("List workspaces you belong to")
        .action(async () => {
        const list = await fetchWorkspaces();
        if (isJSONMode()) {
            printJSON(list);
            return;
        }
        if (list.length === 0) {
            console.log("No workspaces. The backend should always return a personal workspace.");
            return;
        }
        table(["Name", "Slug", "Role", "Projects", "Personal"], list.map((w) => [
            w.name,
            w.slug,
            w.role,
            String(w.projectCount ?? 0),
            w.isPersonal ? chalk.green("✓") : "",
        ]));
    });
    for (const op of ["pause", "resume"]) {
        ws.command(op)
            .argument("<name-or-id>", "Workspace name, slug, or ID")
            .description(op === "pause"
            ? "Pause every service in every project of a workspace (owner only; keeps URLs, passwords, settings and data)"
            : "Resume the services you paused in a workspace (owner only)")
            .action(async (nameOrId) => {
            const workspace = await resolveWorkspace(nameOrId);
            if (workspace.role !== "owner")
                throw new Error(`Only the workspace owner can ${op} all of it.`);
            const result = await api.post(`/api/workspaces/${workspace.id}/${op}`);
            if (isJSONMode()) {
                printJSON({ id: workspace.id, ...result });
                return;
            }
            printBulkResult(op, `workspace ${chalk.bold(workspace.name)}`, result);
        });
    }
    ws.command("resale-pricing")
        .alias("resale")
        .argument("<name-or-id>", "Workspace name, slug, or ID")
        .description("Show or set the prices this workspace's scoped API keys see, as multiples of Lizard's (owner only, from a key with no scopes; your bill is unchanged)")
        .option("--all <x>", "Set every resource to this multiplier")
        .option("--cpu <x>", "CPU multiplier (1-100)")
        .option("--memory <x>", "Memory multiplier (1-100)")
        .option("--storage <x>", "Volumes multiplier (1-100)")
        .option("--egress <x>", "Egress multiplier (1-100)")
        .option("--object-storage <x>", "Object storage multiplier (1-100)")
        .option("--sandbox <x>", "Sandbox price multiplier (1-100)")
        .option("--off", "Turn resale prices off: scoped keys see Lizard's prices again")
        .addHelpText("after", `
Examples:
  lizard workspace resale-pricing acme                         # show
  lizard workspace resale-pricing acme --all 3                 # every price x3
  lizard workspace resale-pricing acme --cpu 4 --sandbox 5     # change only these
  lizard workspace resale-pricing acme --off
`)
        .action(async (nameOrId, opts) => {
        const workspace = await resolveWorkspace(nameOrId);
        if (workspace.role && workspace.role !== "owner") {
            throw new Error("Only the workspace owner can see or set resale prices.");
        }
        const path = `/api/workspaces/${workspace.id}/resale-pricing`;
        let result;
        if (opts.off) {
            result = await api.put(path, {});
        }
        else {
            const current = await api.get(path);
            const next = mergeResale(current.multipliers, opts);
            result = next ? await api.put(path, next) : current;
            if (next && !isJSONMode())
                success("Resale prices saved");
        }
        if (isJSONMode()) {
            printJSON({ id: workspace.id, ...result });
            return;
        }
        printResale(workspace, result);
    });
    ws.command("limits")
        .argument("<name-or-id>", "Workspace name, slug, or ID")
        .description("Show what a workspace may run at once and what it uses now; set it (owner only, from a key with no scopes)")
        .option("--sandboxes <n>", "Sandboxes running at once (none = no limit)")
        .option("--cpu <vcpus>", "vCPU its apps and databases may be using (none = no limit)")
        .option("--memory <size>", "Memory its apps and databases may be using, e.g. 4GB, 512MB (none = no limit)")
        .option("--disk <size>", "SSD its databases and volumes may hold, e.g. 20GB, 1TB (none = no limit)")
        .addHelpText("after", `
Examples:
  lizard workspace limits acme                                   # show limits and current use
  lizard workspace limits acme --sandboxes 5 --cpu 2 --memory 4GB --disk 20GB
  lizard workspace limits acme --cpu none                        # remove one limit
`)
        .action(async (nameOrId, opts) => {
        const workspace = await resolveWorkspace(nameOrId);
        const body = limitsBody(opts);
        const path = `/api/workspaces/${workspace.id}/limits`;
        const result = body
            ? await api.put(path, body)
            : await api.get(path);
        if (isJSONMode()) {
            printJSON({ id: workspace.id, ...result });
            return;
        }
        if (body)
            success("Workspace limits saved");
        printLimits(workspace, result.limits, result.usage);
    });
    ws.command("rm")
        .alias("delete")
        .argument("<name-or-id>", "Workspace name, slug, or ID")
        .description("Delete an empty workspace")
        .option("-y, --yes", "Skip confirmation")
        .action(async (nameOrId, opts) => {
        const workspace = await resolveWorkspace(nameOrId);
        if (workspace.isPersonal) {
            throw new Error("Cannot delete your personal workspace.");
        }
        if (workspace.role !== "owner") {
            throw new Error("Only the workspace owner can delete it.");
        }
        // Empty workspaces only: the backend checks that with ?requireEmpty=true (live
        // projects, sandboxes and volumes) and says what is left. The list's projectCount
        // also counts projects in the 3-day trash, so a client-side check here refused a
        // workspace whose projects had all just been deleted.
        if (!opts.yes && isTTY() && !isJSONMode()) {
            const ok = await p.confirm({ message: `Delete workspace ${chalk.bold(workspace.name)}?` });
            if (p.isCancel(ok) || !ok)
                process.exit(5);
        }
        await api.delete(withQuery(`/api/workspaces/${workspace.id}`, { requireEmpty: true }));
        if (isJSONMode())
            printJSON({ id: workspace.id, status: "deleted" });
        else
            success(`Workspace ${chalk.bold(workspace.name)} deleted`);
    });
}
//# sourceMappingURL=workspace.js.map