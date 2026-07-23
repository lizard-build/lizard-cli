import chalk from "chalk";
import * as p from "@clack/prompts";
import { Command } from "commander";
import { api } from "../lib/api.js";
import { resolveProjectId } from "../lib/config.js";
import { resolveWorkspace } from "../lib/picker.js";
import {
  isJSONMode,
  printJSON,
  table,
  success,
  info,
  warn,
  timeAgo,
  isTTY,
} from "../lib/format.js";

interface KeyScope {
  type: "workspace" | "project";
  id: string;
  name: string;
}

interface ApiKeyRecord {
  id: string;
  name: string;
  keyPreview: string;
  createdAt?: number | string | null;
  lastUsedAt?: number | string | null;
  scopes: KeyScope[];
}

interface CreatedApiKey {
  id: string;
  name: string;
  key: string;
  scopes: Array<{ type: "workspace" | "project"; id: string }>;
  createdAt?: number | string | null;
}

/** Collect a repeatable option into an array. */
function collect(value: string, prev: string[]): string[] {
  return [...prev, value];
}

/**
 * `lizard keys` — create, list, and delete API keys.
 *
 * A key with no scope has full access. `--project` / `--workspace` (both
 * repeatable) restrict it, matching the dashboard's scoping.
 */
export function registerKeys(program: Command) {
  const keys = program
    .command("keys")
    .alias("apikey")
    .description("Manage API keys");

  keys
    .command("create")
    .argument("<name>", "Key name")
    .description("Create an API key, optionally restricted to projects/workspaces")
    .option("-p, --project <id>", "Restrict to a project (name, slug, or ID); repeatable", collect, [])
    .option("-w, --workspace <id>", "Restrict to a workspace (name, slug, or ID); repeatable", collect, [])
    .action(async (name: string, opts: { project: string[]; workspace: string[] }) => {
      const scopes: Array<{ type: "workspace" | "project"; id: string }> = [];
      // Resolve names/slugs to IDs before hitting the API. The backend also
      // checks access to each scope and rejects with 403 if the user lacks it.
      for (const proj of opts.project) {
        scopes.push({ type: "project", id: await resolveProjectId(proj) });
      }
      for (const ws of opts.workspace) {
        scopes.push({ type: "workspace", id: (await resolveWorkspace(ws)).id });
      }

      const created = await api.post<CreatedApiKey>("/api/account/api-keys", { name, scopes });

      if (isJSONMode()) {
        printJSON(created);
        return;
      }

      success(`API key ${chalk.bold(created.name)} created`);
      console.log();
      console.log(`  ${chalk.bold(created.key)}`);
      console.log();
      if (scopes.length === 0) {
        warn("Full access — this key can reach every workspace and project you can.");
      } else {
        info(chalk.dim(`  Restricted to ${scopes.length} ${scopes.length === 1 ? "resource" : "resources"}.`));
      }
      warn("Copy it now — it won't be shown again.");
    });

  keys
    .command("list")
    .alias("ls")
    .description("List your API keys")
    .action(async () => {
      const list = await api.get<ApiKeyRecord[]>("/api/account/api-keys");

      if (isJSONMode()) {
        printJSON(list);
        return;
      }

      if (list.length === 0) {
        console.log("No API keys. Use `lizard keys create <name>`.");
        return;
      }

      table(
        ["Name", "Key", "Scope", "Created", "Last used"],
        list.map((k) => [
          k.name,
          k.keyPreview,
          k.scopes.length
            ? k.scopes.map((s) => `${s.type}:${s.name}`).join(", ")
            : chalk.dim("full access"),
          k.createdAt ? timeAgo(k.createdAt) : chalk.dim("—"),
          k.lastUsedAt ? timeAgo(k.lastUsedAt) : chalk.dim("never"),
        ]),
      );
    });

  keys
    .command("rm")
    .alias("delete")
    .argument("<name-or-id>", "Key name or ID")
    .description("Delete an API key")
    .option("-y, --yes", "Skip confirmation")
    .action(async (nameOrId: string, opts: { yes?: boolean }) => {
      const list = await api.get<ApiKeyRecord[]>("/api/account/api-keys");
      const lower = nameOrId.toLowerCase();
      const matches = list.filter(
        (k) => k.id.toLowerCase() === lower || k.name.toLowerCase() === lower,
      );
      if (matches.length === 0) {
        throw new Error(`API key "${nameOrId}" not found.`);
      }
      if (matches.length > 1) {
        throw new Error(
          `Multiple keys named "${nameOrId}". Delete by ID: ${matches.map((m) => m.id).join(", ")}.`,
        );
      }
      const target = matches[0];

      if (!opts.yes && isTTY() && !isJSONMode()) {
        const ok = await p.confirm({ message: `Delete API key ${chalk.bold(target.name)}?` });
        if (p.isCancel(ok) || !ok) process.exit(5);
      }

      await api.delete(`/api/account/api-keys/${target.id}`);
      if (isJSONMode()) printJSON({ id: target.id, status: "deleted" });
      else success(`API key ${chalk.bold(target.name)} deleted`);
    });
}
