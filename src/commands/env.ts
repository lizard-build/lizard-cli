import { Command } from "commander";
import { api } from "../lib/api.js";
import { resolveProjectId } from "../lib/config.js";
import { resolveService } from "../lib/resolve.js";
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
    .alias("environment")
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

  // Railway-compat: `lizard environment edit --service-config <svc> <dot.path> <value>`
  // Patches one or more service-config fields via /api/projects/:id/config:apply.
  // Repeatable triples: --service-config api build.buildCommand "pnpm build" --service-config api deploy.startCommand "pnpm start"
  env
    .command("edit")
    .description("Edit per-service configuration on the active environment")
    .option(
      "-s, --service-config <args...>",
      "Repeatable triple: <SERVICE> <DOT_PATH> <VALUE>",
    )
    .option("-m, --message <text>", "Message to attach to the change")
    .action(async (opts) => {
      const projectId = resolveProjectId(program.opts().project);
      const triples: string[] = opts.serviceConfig ?? [];
      if (triples.length === 0) {
        throw new Error(
          "Pass --service-config <SERVICE> <DOT_PATH> <VALUE> (repeatable).",
        );
      }
      if (triples.length % 3 !== 0) {
        throw new Error(
          "--service-config expects triples: <SERVICE> <DOT_PATH> <VALUE>",
        );
      }

      // Group all triples by service so a single config:apply covers everything.
      const byService = new Map<string, { name: string; flat: Record<string, unknown> }>();
      for (let i = 0; i < triples.length; i += 3) {
        const [svcRef, dotPath, rawValue] = [triples[i], triples[i + 1], triples[i + 2]];
        const svc = await resolveService(projectId, svcRef);
        const value = coerceValue(dotPath, rawValue);
        const entry = byService.get(svc.id) ?? { name: svc.name, flat: {} };
        applyDotPath(entry.flat, dotPath, value);
        byService.set(svc.id, entry);
      }

      const services = Array.from(byService.values()).map((e) => ({
        name: e.name,
        ...e.flat,
      }));

      const result = await api.post<{
        ok?: boolean;
        revision?: number;
        services?: any[];
      }>(`/api/projects/${projectId}/config:apply`, { services });

      if (isJSONMode()) {
        printJSON({
          ok: result?.ok ?? true,
          revision: result?.revision,
          services: result?.services,
          message: opts.message,
        });
        return;
      }
      success(
        `Service configuration applied` +
          (opts.message ? ` (${opts.message})` : ""),
      );
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

// ── helpers for `environment edit --service-config` ─────────────────────────

// Map a Railway-style dot-path to the flat field the server expects on a
// service-config patch (see server `/api/projects/:id/config:apply`).
const DOT_PATH_FIELD: Record<string, string> = {
  "build.builder": "builder",
  "build.buildCommand": "buildCommand",
  "build.watchPatterns": "watchPatterns",
  "build.dockerfilePath": "dockerfilePath",
  "deploy.startCommand": "startCommand",
  "deploy.preDeployCommand": "preDeployCommand",
  "deploy.healthcheckPath": "healthcheckPath",
  "deploy.healthcheckTimeout": "healthcheckTimeoutMs",
  "deploy.numReplicas": "desiredReplicas",
  "deploy.restartPolicyType": "restartPolicyType",
  "source.repo": "repoUrl",
  "source.branch": "branch",
  "source.image": "image",
  "source.rootDirectory": "rootDirectory",
};

function applyDotPath(flat: Record<string, unknown>, dotPath: string, value: unknown) {
  // variables.<KEY>.value → envVars[KEY]
  if (dotPath.startsWith("variables.")) {
    const rest = dotPath.slice("variables.".length);
    const dot = rest.indexOf(".");
    const key = dot === -1 ? rest : rest.slice(0, dot);
    const env = (flat.envVars as Record<string, string>) ?? {};
    env[key] = String(value);
    flat.envVars = env;
    return;
  }
  const field = DOT_PATH_FIELD[dotPath];
  if (!field) {
    throw new Error(
      `Unknown config path "${dotPath}". Try one of: ${Object.keys(DOT_PATH_FIELD).join(", ")}.`,
    );
  }
  flat[field] = value;
}

function coerceValue(dotPath: string, raw: string): any {
  if (
    dotPath === "deploy.numReplicas" ||
    dotPath === "deploy.healthcheckTimeout"
  ) {
    const n = Number(raw);
    if (Number.isNaN(n)) throw new Error(`${dotPath} expects a number, got "${raw}"`);
    return n;
  }
  if (dotPath === "build.watchPatterns") {
    const t = raw.trim();
    if (t.startsWith("[")) {
      try { return JSON.parse(t); } catch {
        throw new Error(`Invalid JSON array for ${dotPath}: ${raw}`);
      }
    }
    return t.split(",").map((s) => s.trim()).filter(Boolean);
  }
  if (dotPath === "deploy.restartPolicyType") {
    return String(raw).toLowerCase().replace(/_/g, "-");
  }
  return raw;
}
