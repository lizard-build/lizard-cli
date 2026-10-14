import chalk from "chalk";
import * as p from "@clack/prompts";
import { Command } from "commander";
import { api, withQuery, type Workspace } from "../lib/api.js";
import { fetchWorkspaces, resolveWorkspace } from "../lib/picker.js";
import { isJSONMode, printJSON, table, success, info, isTTY } from "../lib/format.js";
import { printBulkResult, type BulkPauseResult } from "./pause.js";

export const RESALE_FIELDS = [
  { key: "cpu", flag: "cpu", label: "CPU" },
  { key: "memory", flag: "memory", label: "Memory" },
  { key: "storage", flag: "storage", label: "Volumes" },
  { key: "egress", flag: "egress", label: "Egress" },
  { key: "objectStorage", flag: "objectStorage", label: "Object storage" },
  { key: "sandbox", flag: "sandbox", label: "Sandboxes" },
] as const;
export type ResaleMultipliers = Record<(typeof RESALE_FIELDS)[number]["key"], number>;
export type ResalePricing = { enabled: boolean; multipliers: ResaleMultipliers };

/**
 * The multipliers to save: the current ones with the given flags changed (`--all` first,
 * then each resource flag). Null when no flag was given (show only).
 */
export function mergeResale(
  current: ResaleMultipliers,
  opts: Partial<Record<(typeof RESALE_FIELDS)[number]["flag"] | "all", string>>,
): ResaleMultipliers | null {
  const parse = (name: string, raw: string) => {
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
    for (const f of RESALE_FIELDS) next[f.key] = n;
    changed = true;
  }
  for (const f of RESALE_FIELDS) {
    const raw = opts[f.flag];
    if (raw !== undefined) { next[f.key] = parse(f.flag, raw); changed = true; }
  }
  return changed ? next : null;
}

function printResale(workspace: Workspace, r: ResalePricing) {
  if (!r.enabled) {
    info(`Workspace ${chalk.bold(workspace.name)}: no resale prices. Its scoped API keys see Lizard's prices.`);
    return;
  }
  info(`Workspace ${chalk.bold(workspace.name)}: API keys scoped to it see these multiples of Lizard's prices.`);
  table(["Resource", "Multiplier"], RESALE_FIELDS.map((f) => [f.label, `${r.multipliers[f.key]}x`]));
  info(chalk.dim("  Your own dashboard, keys with no scopes and your bill keep Lizard's prices."));
}

/**
 * `lizard workspace` — create, list, and delete workspaces.
 *
 * Delete only removes empty workspaces (no projects, no sandboxes). `resale-pricing` sets the
 * prices a workspace's scoped keys are shown (a reseller's users). Member
 * management (invite/remove/rename) intentionally lives in the dashboard, not
 * here, to keep the CLI surface narrow (Railway model).
 */
export function registerWorkspace(program: Command) {
  const ws = program
    .command("workspace")
    .description("Create, list, and delete workspaces");

  ws.command("create")
    .argument("<name>", "Workspace name")
    .description("Create a new workspace")
    .action(async (name: string) => {
      const workspace = await api.post<Workspace>("/api/workspaces", { name });

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

      table(
        ["Name", "Slug", "Role", "Projects", "Personal"],
        list.map((w) => [
          w.name,
          w.slug,
          w.role,
          String(w.projectCount ?? 0),
          w.isPersonal ? chalk.green("✓") : "",
        ]),
      );
    });

  for (const op of ["pause", "resume"] as const) {
    ws.command(op)
      .argument("<name-or-id>", "Workspace name, slug, or ID")
      .description(op === "pause"
        ? "Pause every service in every project of a workspace (owner only; keeps URLs, passwords, settings and data)"
        : "Resume the services you paused in a workspace (owner only)")
      .action(async (nameOrId: string) => {
        const workspace = await resolveWorkspace(nameOrId);
        if (workspace.role !== "owner") throw new Error(`Only the workspace owner can ${op} all of it.`);
        const result = await api.post<BulkPauseResult>(`/api/workspaces/${workspace.id}/${op}`);
        if (isJSONMode()) { printJSON({ id: workspace.id, ...result }); return; }
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
    .action(async (nameOrId: string, opts: Record<string, string | boolean | undefined>) => {
      const workspace = await resolveWorkspace(nameOrId);
      if (workspace.role && workspace.role !== "owner") {
        throw new Error("Only the workspace owner can see or set resale prices.");
      }
      const path = `/api/workspaces/${workspace.id}/resale-pricing`;
      let result: ResalePricing;
      if (opts.off) {
        result = await api.put<ResalePricing>(path, {});
      } else {
        const current = await api.get<ResalePricing>(path);
        const next = mergeResale(current.multipliers, opts as Parameters<typeof mergeResale>[1]);
        result = next ? await api.put<ResalePricing>(path, next) : current;
        if (next && !isJSONMode()) success("Resale prices saved");
      }
      if (isJSONMode()) { printJSON({ id: workspace.id, ...result }); return; }
      printResale(workspace, result);
    });

  ws.command("rm")
    .alias("delete")
    .argument("<name-or-id>", "Workspace name, slug, or ID")
    .description("Delete an empty workspace")
    .option("-y, --yes", "Skip confirmation")
    .action(async (nameOrId: string, opts: { yes?: boolean }) => {
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
        if (p.isCancel(ok) || !ok) process.exit(5);
      }

      await api.delete(withQuery(`/api/workspaces/${workspace.id}`, { requireEmpty: true }));
      if (isJSONMode()) printJSON({ id: workspace.id, status: "deleted" });
      else success(`Workspace ${chalk.bold(workspace.name)} deleted`);
    });
}
