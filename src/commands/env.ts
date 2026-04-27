import { Command } from "commander";
import { api } from "../lib/api.js";
import { resolveProjectId } from "../lib/config.js";
import { success, isJSONMode, printJSON, table, info } from "../lib/format.js";

interface Environment {
  id: string;
  name: string;
  projectId: string;
  createdAt: number;
  updatedAt: number;
}

function parsePairs(pairs: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of pairs) {
    const eqIdx = pair.indexOf("=");
    if (eqIdx < 1) throw new Error(`Invalid format: "${pair}". Use KEY=value`);
    out[pair.slice(0, eqIdx)] = pair.slice(eqIdx + 1);
  }
  return out;
}

export function registerEnv(program: Command) {
  const env = program
    .command("env")
    .description("Manage environments within a project");

  env
    .command("list")
    .description("List environments in the project")
    .action(async () => {
      const projectId = resolveProjectId(program.opts().project);
      const envs = await api.get<Environment[]>(`/api/projects/${projectId}/environments`);

      if (isJSONMode()) {
        printJSON(envs);
        return;
      }

      if (envs.length === 0) {
        info(`No environments. Use \`lizard env create <name>\` to add one.`);
        return;
      }

      table(
        ["ID", "Name"],
        envs.map((e) => [e.id, e.name]),
      );
    });

  env
    .command("create")
    .argument("<name>", "Environment name")
    .description("Create a new environment")
    .option("--from <envId>", "Copy env vars from an existing environment")
    .action(async (name: string, opts) => {
      const projectId = resolveProjectId(program.opts().project);
      const body: { name: string; sourceEnvironmentId?: string } = { name };
      if (opts.from) body.sourceEnvironmentId = opts.from;

      const created = await api.post<Environment>(`/api/projects/${projectId}/environments`, body);

      if (isJSONMode()) {
        printJSON(created);
        return;
      }

      success(`Environment "${created.name}" created (${created.id})`);
    });

  env
    .command("delete")
    .argument("<id>", "Environment ID")
    .description("Delete an environment")
    .action(async (id: string) => {
      await api.delete(`/api/environments/${id}`);

      if (isJSONMode()) {
        printJSON({ ok: true, id });
        return;
      }

      success(`Environment ${id} deleted`);
    });

  // `env vars` — manage env vars scoped to a specific environment
  const vars = env
    .command("vars")
    .description("Manage env vars for a specific environment");

  vars
    .command("set")
    .argument("<envId>", "Environment ID")
    .argument("[pairs...]", "KEY=value pairs to set")
    .description("Apply (or stage) env vars for an environment")
    .option("--stage", "Stage changes without applying to running services")
    .action(async (envId: string, pairs: string[], opts) => {
      const newVars = pairs.length > 0 ? parsePairs(pairs) : {};

      const current = await api.get<{ envVars: Record<string, string> }>(
        `/api/environments/${envId}/config`,
      );
      const merged = { ...current.envVars, ...newVars };

      const result = await api.post<{ ok: boolean; staged: boolean }>(
        `/api/environments/${envId}/config/apply`,
        { envVars: merged, stage: opts.stage ?? false },
      );

      if (isJSONMode()) {
        printJSON(result);
        return;
      }

      if (result.staged) {
        success(`Vars staged for environment ${envId} (not yet applied)`);
      } else {
        success(`${Object.keys(merged).length} var(s) applied to environment ${envId}`);
      }
    });

  vars
    .command("list")
    .argument("<envId>", "Environment ID")
    .description("List env vars for an environment")
    .action(async (envId: string) => {
      const data = await api.get<{ envVars: Record<string, string>; stagedEnvVars: Record<string, string> | null }>(
        `/api/environments/${envId}/config`,
      );

      if (isJSONMode()) {
        printJSON(data);
        return;
      }

      const pairs = Object.entries(data.envVars);
      if (pairs.length === 0) {
        info("No env vars set for this environment.");
      } else {
        table(["Key", "Value"], pairs);
      }

      if (data.stagedEnvVars) {
        const staged = Object.entries(data.stagedEnvVars);
        if (staged.length > 0) {
          console.log("\nStaged (not yet applied):");
          table(["Key", "Value"], staged);
        }
      }
    });
}
