import chalk from "chalk";
import fs from "node:fs";
import { Command } from "commander";
import { api } from "../lib/api.js";
import { resolveProjectId } from "../lib/config.js";
import { success, info, isJSONMode, printJSON, table, fail } from "../lib/format.js";

// Sandbox environments: what a project's new sandboxes start with (the dashboard's Sandboxes →
// Environment tab). Server: /api/projects/:id/sandbox-environment (the default environment: its
// variables, the agents' instruction files, GitHub access) and /sandbox-environments (named
// environments: variables only). `lizard sandbox create -e <name>` picks one.

interface Summary { id: string; name: string; default: boolean; variableCount: number }
interface Variable { key: string; value: string }
interface ProjectEnvironment {
  variables: Variable[];
  instructions: { claudeMd: string | null; agentsMd: string | null };
  github: { account: string; access: "read" | "write"; workflows: boolean; enabled: boolean; repos: { id: number; fullName: string }[] } | null;
}

const INSTRUCTIONS_MAX_BYTES = 32_768;
const isDefault = (name?: string) => !name || name.trim().toLowerCase() === "default";
const base = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}/sandbox-environment`;
const named = (projectId: string, name: string) => `${base(projectId)}s/${encodeURIComponent(name.trim())}`;

/** The server answers a bare 404 while the feature is off for the account: say that, not "not found". */
async function call<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e: any) {
    if (e?.status === 404 && !e?.code && /^not found$/i.test(String(e?.message ?? "").trim())) {
      fail("Sandbox environments are not available on this account yet", 1, "SANDBOX_ENVIRONMENT_NOT_ENABLED");
    }
    throw e;
  }
}

/** KEY=VALUE arguments (and --from-file lines) as { KEY: value }. */
export function parseAssignments(pairs: string[], file?: string): Record<string, string> {
  const out: Record<string, string> = {};
  const take = (line: string, where: string) => {
    const i = line.indexOf("=");
    if (i <= 0) fail(`${where}: expected KEY=VALUE, got "${line.slice(0, 40)}"`, 2, "USAGE");
    out[line.slice(0, i).trim()] = line.slice(i + 1);
  };
  if (file) {
    for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const stripped = line.replace(/^export\s+/, "");
      const i = stripped.indexOf("=");
      if (i <= 0) fail(`${file}: expected KEY=VALUE, got "${line.slice(0, 40)}"`, 2, "USAGE");
      // A value in matching quotes is taken without them, as a .env file means it.
      const value = stripped.slice(i + 1).trim().replace(/^(["'])(.*)\1$/, "$2");
      out[stripped.slice(0, i).trim()] = value;
    }
  }
  for (const p of pairs) take(p, "argument");
  return out;
}

const mask = (v: string) => (v.length <= 4 ? "****" : `${v.slice(0, 2)}****${v.slice(-2)}`);

function readInstructions(path: string): string {
  const text = fs.readFileSync(path, "utf8");
  if (Buffer.byteLength(text, "utf8") > INSTRUCTIONS_MAX_BYTES) fail(`${path} is larger than ${INSTRUCTIONS_MAX_BYTES / 1024} KB`, 2, "USAGE");
  return text;
}

export function registerSandboxEnvironmentCommands(sb: Command) {
  const project = (c: Command) => c.option("-p, --project <id>", "Project (name, slug, or ID). Defaults to the linked project.");

  project(sb.command("environments").alias("envs")
    .description("List the project's sandbox environments: the sets of variables a new sandbox can start with (create -e <name>)"))
    .addHelpText("after", `
A project's new sandboxes start with its environment: variables, the agents' instruction files
(CLAUDE.md / AGENTS.md) and GitHub access. The Default environment is the project's own; a named
environment is another complete set of variables, used INSTEAD of the default's when a sandbox is
created with it. Instructions and GitHub access are the project's, whatever the environment.

  lizard sandbox environment-create staging --copy-from default
  lizard sandbox environment-set -e staging API_URL=https://staging.example.com
  lizard sandbox create -e staging`)
    .action(async (opts) => {
      const projectId = await resolveProjectId(opts.project);
      const [list, env] = await call(() => Promise.all([
        api.get<{ environments: Summary[]; canCreate: boolean }>(`${base(projectId)}s`),
        api.get<ProjectEnvironment>(base(projectId)),
      ]));
      if (isJSONMode()) {
        return printJSON({
          environments: list.environments, canCreate: list.canCreate,
          instructions: { claudeMd: env.instructions.claudeMd !== null, agentsMd: env.instructions.agentsMd !== null },
          github: env.github ? { account: env.github.account, access: env.github.access, enabled: env.github.enabled, repos: env.github.repos.map((r) => r.fullName) } : null,
        });
      }
      table(["environment", "variables"], list.environments.map((e) => [e.default ? `${e.name} ${chalk.dim("(default)")}` : e.name, String(e.variableCount)]));
      const files = [env.instructions.claudeMd !== null && "CLAUDE.md", env.instructions.agentsMd !== null && "AGENTS.md"].filter(Boolean);
      info(chalk.dim(`Agent instructions: ${files.length ? files.join(", ") : "none"}`));
      info(chalk.dim(`GitHub access: ${!env.github ? "not set" : `${env.github.enabled ? env.github.access : "off"}, ${env.github.repos.length} ${env.github.repos.length === 1 ? "repository" : "repositories"} of ${env.github.account}`}`));
      if (!list.canCreate) info(chalk.dim("More than one environment per project is not available on this account yet."));
    });

  project(sb.command("environment-show").alias("env-show")
    .argument("[name]", "Environment name (default: the project's default environment)")
    .description("Show an environment's variables (values masked; --values prints them)")
    .option("--values", "Print the values in full"))
    .action(async (name: string | undefined, opts) => {
      const projectId = await resolveProjectId(opts.project);
      if (!isDefault(name)) {
        const e = await call(() => api.get<{ id: string; name: string; variables: Variable[] }>(named(projectId, name!)));
        if (isJSONMode()) return printJSON(opts.values ? e : { ...e, variables: e.variables.map((v) => ({ key: v.key })) });
        info(chalk.bold(e.name));
        return printVariables(e.variables, opts.values);
      }
      const env = await call(() => api.get<ProjectEnvironment>(base(projectId)));
      if (isJSONMode()) {
        return printJSON({
          id: "default", name: "Default",
          variables: opts.values ? env.variables : env.variables.map((v) => ({ key: v.key })),
          instructions: { claudeMd: env.instructions.claudeMd !== null, agentsMd: env.instructions.agentsMd !== null },
          github: env.github ? { account: env.github.account, access: env.github.access, workflows: env.github.workflows, enabled: env.github.enabled, repos: env.github.repos.map((r) => r.fullName) } : null,
        });
      }
      info(`${chalk.bold("Default")} ${chalk.dim("(the project's own)")}`);
      printVariables(env.variables, opts.values);
      console.log(`\nAgent instructions  CLAUDE.md: ${env.instructions.claudeMd !== null ? "set" : chalk.dim("not set")}   AGENTS.md: ${env.instructions.agentsMd !== null ? "set" : chalk.dim("not set")}`);
      if (!env.github) console.log(`GitHub access       ${chalk.dim("not set (set it in the dashboard: Sandboxes → Environment)")}`);
      else {
        console.log(`GitHub access       ${env.github.enabled ? env.github.access : chalk.yellow("off")}${env.github.workflows ? " + workflows" : ""}, ${env.github.account}`);
        for (const r of env.github.repos) console.log(`  ${r.fullName}`);
      }
    });

  project(sb.command("environment-create").alias("env-create")
    .argument("<name>", "Name: letters, digits, spaces and . _ -, at most 40 characters")
    .description("Create a named environment: another set of variables a sandbox can start with")
    .option("--copy-from <name>", "Start with the variables of another environment (\"default\" or a name)"))
    .action(async (name: string, opts) => {
      const projectId = await resolveProjectId(opts.project);
      const e = await call(() => api.post<{ id: string; name: string; variables: Variable[] }>(`${base(projectId)}s`, { name, ...(opts.copyFrom ? { copyFrom: opts.copyFrom } : {}) }));
      if (isJSONMode()) return printJSON({ id: e.id, name: e.name, variables: e.variables.map((v) => ({ key: v.key })) });
      success(`Environment ${chalk.bold(e.name)} created${e.variables.length ? ` with ${e.variables.length} variable${e.variables.length === 1 ? "" : "s"}` : ""}`);
      info(chalk.dim(`  lizard sandbox environment-set -e "${e.name}" KEY=VALUE   add variables`));
      info(chalk.dim(`  lizard sandbox create -e "${e.name}"                     start a sandbox with it`));
    });

  project(sb.command("environment-set").alias("env-set")
    .argument("[assignments...]", "KEY=VALUE ...")
    .description("Set variables in an environment (new sandboxes get them; running ones keep what they started with)")
    .option("-e, --environment <name>", "Environment (default: the project's default environment)")
    .option("--from-file <path>", "Also read KEY=VALUE lines from a file (.env format)"))
    .action(async (pairs: string[], opts) => {
      const changes = parseAssignments(pairs, opts.fromFile);
      if (!Object.keys(changes).length) fail("Nothing to set: give KEY=VALUE or --from-file .env", 2, "USAGE");
      const projectId = await resolveProjectId(opts.project);
      await call(() => api.put(isDefault(opts.environment) ? `${base(projectId)}/variables` : `${named(projectId, opts.environment)}/variables`, changes));
      if (isJSONMode()) return printJSON({ ok: true, environment: isDefault(opts.environment) ? "default" : opts.environment, set: Object.keys(changes) });
      success(`Set ${Object.keys(changes).join(", ")} in ${chalk.bold(isDefault(opts.environment) ? "Default" : opts.environment)}`);
    });

  project(sb.command("environment-unset").alias("env-unset")
    .argument("<keys...>", "Variable names")
    .description("Remove variables from an environment")
    .option("-e, --environment <name>", "Environment (default: the project's default environment)"))
    .action(async (keys: string[], opts) => {
      const projectId = await resolveProjectId(opts.project);
      const changes = Object.fromEntries(keys.map((k) => [k, null]));
      await call(() => api.put(isDefault(opts.environment) ? `${base(projectId)}/variables` : `${named(projectId, opts.environment)}/variables`, changes));
      if (isJSONMode()) return printJSON({ ok: true, environment: isDefault(opts.environment) ? "default" : opts.environment, removed: keys });
      success(`Removed ${keys.join(", ")} from ${chalk.bold(isDefault(opts.environment) ? "Default" : opts.environment)}`);
    });

  project(sb.command("environment-rename").alias("env-rename")
    .argument("<name>", "Environment name")
    .argument("<newName>", "New name")
    .description("Rename a named environment"))
    .action(async (name: string, newName: string, opts) => {
      if (isDefault(name)) fail("The default environment cannot be renamed", 2, "USAGE");
      const projectId = await resolveProjectId(opts.project);
      const e = await call(() => api.patch<{ id: string; name: string }>(named(projectId, name), { name: newName }));
      if (isJSONMode()) return printJSON(e);
      success(`Environment renamed to ${chalk.bold(e.name)}`);
    });

  project(sb.command("environment-rm").alias("env-rm").alias("environment-delete")
    .argument("<name>", "Environment name")
    .description("Delete a named environment (sandboxes already created with it keep their variables)"))
    .action(async (name: string, opts) => {
      if (isDefault(name)) fail("The default environment cannot be deleted; remove its variables with environment-unset", 2, "USAGE");
      const projectId = await resolveProjectId(opts.project);
      await call(() => api.delete(named(projectId, name)));
      if (isJSONMode()) return printJSON({ name, deleted: true });
      success(`Environment ${chalk.bold(name)} deleted`);
    });

  project(sb.command("environment-instructions").alias("env-instructions")
    .description("Show or set the agents' instruction files every new sandbox of the project gets (CLAUDE.md, AGENTS.md)")
    .option("--claude-md <path>", "Set the user-level CLAUDE.md (Claude Code) from a file")
    .option("--agents-md <path>", "Set the user-level AGENTS.md (Codex, OpenCode, pi, Prime) from a file")
    .option("--clear-claude-md", "Remove CLAUDE.md")
    .option("--clear-agents-md", "Remove AGENTS.md")
    .option("--print <file>", "Print one in full: claude-md or agents-md"))
    .action(async (opts) => {
      const projectId = await resolveProjectId(opts.project);
      const body: Record<string, string | null> = {};
      if (opts.claudeMd) body.claudeMd = readInstructions(opts.claudeMd);
      if (opts.agentsMd) body.agentsMd = readInstructions(opts.agentsMd);
      if (opts.clearClaudeMd) body.claudeMd = null;
      if (opts.clearAgentsMd) body.agentsMd = null;
      if (Object.keys(body).length) {
        await call(() => api.put(`${base(projectId)}/instructions`, body));
        if (isJSONMode()) return printJSON({ ok: true, changed: Object.keys(body) });
        return success(`Agent instructions updated: ${Object.entries(body).map(([k, v]) => `${k === "claudeMd" ? "CLAUDE.md" : "AGENTS.md"} ${v === null ? "removed" : "set"}`).join(", ")}`);
      }
      const env = await call(() => api.get<ProjectEnvironment>(base(projectId)));
      if (opts.print) {
        const which = String(opts.print).toLowerCase().replace(/[^a-z]/g, "");
        if (which !== "claudemd" && which !== "agentsmd") fail("--print takes claude-md or agents-md", 2, "USAGE");
        const text = which === "claudemd" ? env.instructions.claudeMd : env.instructions.agentsMd;
        if (isJSONMode()) return printJSON({ file: which === "claudemd" ? "CLAUDE.md" : "AGENTS.md", text });
        if (text === null) return info("Not set.");
        process.stdout.write(text.endsWith("\n") ? text : text + "\n");
        return;
      }
      if (isJSONMode()) return printJSON({ claudeMd: env.instructions.claudeMd !== null, agentsMd: env.instructions.agentsMd !== null });
      console.log(`CLAUDE.md  ${env.instructions.claudeMd !== null ? `${Buffer.byteLength(env.instructions.claudeMd, "utf8")} bytes` : chalk.dim("not set")}`);
      console.log(`AGENTS.md  ${env.instructions.agentsMd !== null ? `${Buffer.byteLength(env.instructions.agentsMd, "utf8")} bytes` : chalk.dim("not set")}`);
    });
}

function printVariables(vars: Variable[], values: boolean) {
  if (!vars.length) return info(chalk.dim("No variables."));
  table(["variable", "value"], vars.map((v) => [v.key, values ? v.value : chalk.dim(mask(v.value))]));
}
