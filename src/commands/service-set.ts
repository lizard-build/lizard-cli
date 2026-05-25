import chalk from "chalk";
import * as p from "@clack/prompts";
import * as fs from "node:fs";
import { Command } from "commander";
import { api, withScope, type ResourceScope } from "../lib/api.js";
import { resolveProjectScope, resolveService } from "../lib/resolve.js";
import { success, info, isJSONMode, printJSON, isTTY } from "../lib/format.js";

/**
 * `lizard service set` — atomic patch of per-service configuration.
 *
 * Input modes (priority):
 *   1. <service> --set <path>=<value>    — positional service + repeatable --set pairs
 *   2. -f <file>                         — read JSON from file (multi-service)
 *   3. piped stdin JSON                  — auto-detected when stdin has data
 *   4. interactive                       — TTY prompts when nothing else is given
 *
 * Dot-paths supported:
 *   build.buildCommand         string
 *   build.watchPatterns        string[] (JSON array or comma-separated)
 *   build.dockerfilePath       string
 *   deploy.startCommand        string
 *   deploy.healthcheckPath     string
 *   deploy.healthcheckTimeout  number
 *   deploy.restartPolicyType   "ON_FAILURE" | "ALWAYS" | "NEVER"
 *   source.repoUrl             string
 *   source.branch              string
 *   source.rootDirectory       string
 *   variables.<KEY>.value      string (supports ${{...}} references)
 *
 * Note: replica count is changed via `lizard scale`, not here.
 */
export function registerServiceSet(svc: Command) {
  svc
    .command("set")
    .description(
      "Apply build/start/watch/variable changes to a service",
    )
    .argument("[service]", "Service name or ID (required when using --set)")
    .option(
      "--set <pair>",
      "Set a field: <path>=<value>. Repeatable.",
      (val: string, prev: string[]) => [...prev, val],
      [] as string[],
    )
    .option("-f, --file <path>", "JSON config file to apply")
    .option("-s, --service <name>", "Service name or ID")
    .option("-p, --project <id>", "Project name, slug, or ID")
    .option("--force", "Overwrite even if the config was changed remotely")
    .action(async (serviceArg: string | undefined, opts) => {
      const { projectId, scope } = await resolveProjectScope(opts.project);

      const patch = await buildPatch(serviceArg || opts.service, opts, projectId, scope);
      if (!patch || isEmpty(patch)) {
        if (isJSONMode()) {
          printJSON({ staged: false, committed: false, message: "No changes" });
        } else {
          info(chalk.yellow("No changes to apply"));
        }
        return;
      }

      // The backend `/api/projects/:id/config:apply` schema expects:
      //   { services: [{ id, name, buildCommand?, startCommand?, ... }],
      //     addons:   [...],
      //     secrets:  { shared?, services? } }
      // The internal `patch.services` we built is keyed by service id with a
      // nested {build,deploy,source,variables} layout — flatten it before send.
      const body = await flattenPatch(patch, projectId, scope);

      // Fetch current configRevision for CAS — skipped when --force is set.
      if (!opts.force) {
        try {
          const proj = await api.get<{ configRevision?: number | null }>(
            withScope(`/api/projects/${projectId}`, scope),
          );
          if (proj?.configRevision != null) {
            (body as any).revision = proj.configRevision;
          }
        } catch {
          // Non-fatal — proceed without CAS if project fetch fails
        }
      }

      const result = await api
        .post<{
          ok?: boolean;
          revision?: number;
          services?: any[];
          addons?: any[];
        }>(withScope(`/api/projects/${projectId}/config:apply`, scope), body)
        .catch((err: any) => {
          if (err?.status === 409) {
            throw new Error(`${err.message}\nUse --force to overwrite.`);
          }
          if (err?.status === 400) {
            const msg: string = err.message ?? String(err);
            const svcName = msg.match(/Service not found: (\S+)/)?.[1];
            if (svcName) {
              throw new Error(
                `Service '${svcName}' not found in project. To create it, use 'lizard up --service ${svcName}'.`,
              );
            }
            throw new Error(msg);
          }
          throw err;
        });

      if (isJSONMode()) {
        printJSON({
          ok: result?.ok ?? true,
          revision: result?.revision,
          services: result?.services,
          addons: result?.addons,
        });
        return;
      }

      success(`Service configuration applied`);
    });
}

/**
 * Convert the internal nested patch shape (keyed by service id, with build/deploy
 * sub-objects) into the flat array shape the server expects:
 *   { services: [{ name, buildCommand?, startCommand?, ... }], secrets?: {...} }
 *
 * Dot-path mapping: build.X / deploy.X / source.X all collapse to the matching
 * top-level field on the service. `variables.<KEY>.value` becomes envVars[KEY].
 */
async function flattenPatch(
  patch: any,
  projectId: string,
  scope: ResourceScope,
): Promise<{ services: any[]; secrets?: any }> {
  const out: { services: any[]; secrets?: any } = { services: [] };
  if (!patch || typeof patch !== "object") return out;

  const services = patch.services ?? {};
  const idsInPatch = Object.keys(services);

  // Need each service's name (server keys upserts by name, not id)
  let nameById = new Map<string, string>();
  if (idsInPatch.length > 0) {
    const data = await api.get<{ apps?: any[]; addons?: any[] }>(
      withScope(`/api/projects/${projectId}/services`, scope),
    );
    const all = [...(data.apps || []), ...(data.addons || [])];
    nameById = new Map(all.map((s: any) => [s.id, s.name]));
  }

  for (const id of idsInPatch) {
    const cfg = services[id] || {};
    const name = nameById.get(id);
    if (!name) {
      throw new Error(`Service ${id} no longer exists in the project.`);
    }
    const flat: Record<string, unknown> = { id, name };

    // Source group
    if (cfg.source?.repoUrl !== undefined) flat.repoUrl = cfg.source.repoUrl;
    if (cfg.source?.branch !== undefined) flat.branch = cfg.source.branch;
    if (cfg.source?.rootDirectory !== undefined)
      flat.rootDirectory = cfg.source.rootDirectory;

    // Build group
    if (cfg.build?.buildCommand !== undefined)
      flat.buildCommand = cfg.build.buildCommand;
    if (cfg.build?.watchPatterns !== undefined)
      flat.watchPatterns = cfg.build.watchPatterns;
    if (cfg.build?.dockerfilePath !== undefined)
      flat.dockerfilePath = cfg.build.dockerfilePath;

    // Deploy group
    if (cfg.deploy?.startCommand !== undefined)
      flat.startCommand = cfg.deploy.startCommand;
    if (cfg.deploy?.preDeployCommand !== undefined)
      flat.preDeployCommand = cfg.deploy.preDeployCommand;
    if (cfg.deploy?.healthcheckPath !== undefined)
      flat.healthcheckPath = cfg.deploy.healthcheckPath;
    if (cfg.deploy?.healthcheckTimeout !== undefined)
      flat.healthcheckTimeoutMs = cfg.deploy.healthcheckTimeout;
    if (cfg.deploy?.restartPolicyType !== undefined) {
      // Accept ON_FAILURE/ALWAYS/NEVER input; server uses on-failure/always/never
      const v = String(cfg.deploy.restartPolicyType).toLowerCase().replace(/_/g, "-");
      flat.restartPolicyType = v;
    }

    // Variables → envVars (templated values are stored verbatim, deployer resolves)
    if (cfg.variables && typeof cfg.variables === "object") {
      const envVars: Record<string, string> = {};
      for (const [k, raw] of Object.entries(cfg.variables)) {
        envVars[k] = typeof raw === "object" && raw && "value" in (raw as any)
          ? String((raw as any).value)
          : String(raw);
      }
      flat.envVars = envVars;
    }

    // Allow an explicit envVars block at the service level too
    if (cfg.envVars && typeof cfg.envVars === "object") {
      flat.envVars = { ...(flat.envVars as object | undefined), ...cfg.envVars };
    }

    out.services.push(flat);
  }

  // Pass through shared / per-service secrets if the patch carries them
  if (patch.sharedVariables || patch.secrets) {
    const secrets: { shared?: Record<string, string>; services?: Record<string, Record<string, string>> } = {};
    if (patch.sharedVariables) {
      secrets.shared = {};
      for (const [k, raw] of Object.entries(patch.sharedVariables)) {
        secrets.shared[k] =
          typeof raw === "object" && raw && "value" in (raw as any)
            ? String((raw as any).value)
            : String(raw);
      }
    }
    if (patch.secrets?.services) secrets.services = patch.secrets.services;
    if (patch.secrets?.shared) secrets.shared = { ...(secrets.shared || {}), ...patch.secrets.shared };
    out.secrets = secrets;
  }

  return out;
}

// ── input handling ──────────────────────────────────────────────────────────

async function buildPatch(
  serviceArg: string | undefined,
  opts: any,
  projectId: string,
  scope: ResourceScope,
): Promise<any> {
  // 1. <service> --set <path>=<value> (repeatable)
  if (opts.set?.length) {
    if (!serviceArg) {
      throw new Error("Service name is required when using --set. Usage: lizard service set <service> --set <path>=<value>  (or -s <service>)");
    }
    if (opts.file) {
      throw new Error("Cannot combine --set with --file. Use one input mode.");
    }
    return await setPairsToPatch(serviceArg, opts.set, projectId);
  }

  // 2. -f <file> → JSON file
  if (opts.file) {
    const raw = fs.readFileSync(opts.file, "utf-8");
    const parsed = JSON.parse(raw);
    return await normalisePatch(parsed, projectId);
  }

  // 3. Piped stdin → JSON. Only consume when bytes are actually buffered;
  //    otherwise the CLI hangs forever in non-interactive shells.
  if (await stdinHasData()) {
    const stdin = await readStdin();
    const trimmed = stdin.trim();
    if (trimmed) {
      const parsed = JSON.parse(trimmed);
      return await normalisePatch(parsed, projectId);
    }
  }

  // 4. Interactive
  if (isTTY()) {
    return await interactivePatch(projectId, scope);
  }

  return null;
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (c: Buffer) => chunks.push(c));
    process.stdin.on("end", () =>
      resolve(Buffer.concat(chunks).toString("utf-8")),
    );
    process.stdin.on("error", reject);
  });
}

/** Returns true only when stdin is a piped/file source with bytes ready. */
function stdinHasData(): Promise<boolean> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve(false);

    const stdin = process.stdin;
    let answered = false;
    const finish = (v: boolean) => {
      if (answered) return;
      answered = true;
      stdin.removeListener("readable", onReadable);
      stdin.removeListener("end", onEnd);
      clearTimeout(timer);
      resolve(v);
    };

    const onReadable = () => {
      const real = stdin.read();
      if (real) {
        stdin.unshift(real);
        finish(true);
        return;
      }
    };
    const onEnd = () => finish(false);

    stdin.on("readable", onReadable);
    stdin.on("end", onEnd);

    const timer = setTimeout(() => finish(false), 50);
  });
}

/**
 * Normalise a raw user JSON payload. Accepts:
 *   { services: { name|id: { build: ..., deploy: ..., variables: ... } } }
 *   { apps: { name|id: { ... } } }            // alias
 *   { name|id: { ... } }                       // top-level shortcut
 */
async function normalisePatch(raw: any, projectId: string): Promise<any> {
  const root: any = raw.services ?? raw.apps ?? raw;
  if (typeof root !== "object" || Array.isArray(root)) {
    throw new Error("Config must be an object keyed by service name or ID.");
  }

  const services: Record<string, any> = {};
  for (const [key, value] of Object.entries(root)) {
    const svc = await resolveService(projectId, key);
    services[svc.id] = value;
  }

  const out: any = { services };
  if (raw.sharedVariables) out.sharedVariables = raw.sharedVariables;
  return out;
}

/** Convert a list of "<path>=<value>" pairs (for one service) into a nested patch. */
async function setPairsToPatch(
  serviceRef: string,
  pairs: string[],
  projectId: string,
): Promise<any> {
  const svc = await resolveService(projectId, serviceRef);
  const cfg: Record<string, any> = {};

  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq <= 0) {
      throw new Error(
        `--set expects <path>=<value>, got "${pair}"`,
      );
    }
    const dotPath = pair.slice(0, eq).trim();
    const rawValue = pair.slice(eq + 1);
    const value = parseValue(dotPath, rawValue);
    setDeep(cfg, dotPath, value);
  }

  return { services: { [svc.id]: cfg } };
}

/** Interactive prompt loop. Pick service → pick field → enter value. */
async function interactivePatch(projectId: string, scope: ResourceScope): Promise<any> {
  const data = await api.get<{ apps?: any[]; addons?: any[] }>(
    withScope(`/api/projects/${projectId}/services`, scope),
  );
  const services = [...(data.apps || []), ...(data.addons || [])];
  if (services.length === 0) {
    throw new Error("No services in project. Use `lizard add` first.");
  }

  const out: Record<string, any> = {};

  while (true) {
    const svcId = await p.select({
      message: "Configure which service?",
      options: [
        ...services.map((s: any) => ({
          value: s.id,
          label: s.name,
          hint: s.status,
        })),
        { value: "__done__", label: "Done — apply changes" },
      ],
    });
    if (p.isCancel(svcId) || svcId === "__done__") break;

    const field = await p.select({
      message: "What to change?",
      options: [
        { value: "deploy.startCommand", label: "Start command" },
        { value: "build.buildCommand", label: "Build command" },
        { value: "build.watchPatterns", label: "Watch patterns" },
        { value: "build.dockerfilePath", label: "Dockerfile path" },
        { value: "deploy.healthcheckPath", label: "Healthcheck path" },
        { value: "deploy.restartPolicyType", label: "Restart policy" },
        { value: "source.branch", label: "Branch" },
        { value: "source.rootDirectory", label: "Root directory" },
        { value: "source.repoUrl", label: "GitHub repo" },
      ],
    });
    if (p.isCancel(field)) break;

    const valueInput = await p.text({
      message: `${field}`,
      placeholder:
        field === "build.watchPatterns"
          ? "comma-separated or JSON array"
          : "value",
    });
    if (p.isCancel(valueInput)) break;

    const parsed = parseValue(field as string, String(valueInput));
    out[svcId as string] = out[svcId as string] || {};
    setDeep(out[svcId as string], field as string, parsed);
  }

  return { services: out };
}

// ── value coercion ──────────────────────────────────────────────────────────

function parseValue(dotPath: string, raw: string): any {
  if (
    dotPath === "deploy.healthcheckTimeout" ||
    dotPath === "deploy.restartPolicyMaxRetries"
  ) {
    const n = Number(raw);
    if (Number.isNaN(n)) throw new Error(`${dotPath} expects a number, got "${raw}"`);
    return n;
  }

  if (dotPath === "deploy.sleepApplication") {
    return raw === "true" || raw === "1";
  }

  if (dotPath === "build.watchPatterns") {
    const trimmed = raw.trim();
    if (trimmed.startsWith("[")) {
      try {
        return JSON.parse(trimmed);
      } catch {
        throw new Error(`Invalid JSON array for ${dotPath}: ${raw}`);
      }
    }
    return trimmed.split(",").map((s) => s.trim()).filter(Boolean);
  }

  const trimmed = raw.trim();
  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // store as string
    }
  }

  return raw;
}

function setDeep(obj: Record<string, any>, dotPath: string, value: any) {
  const keys = dotPath.split(".");
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    if (typeof cur[k] !== "object" || cur[k] === null) cur[k] = {};
    cur = cur[k];
  }
  cur[keys[keys.length - 1]] = value;
}

function isEmpty(obj: any): boolean {
  if (!obj || typeof obj !== "object") return true;
  if (Array.isArray(obj)) return obj.length === 0;
  if (obj.services && Object.keys(obj.services).length === 0) return true;
  return Object.keys(obj).length === 0;
}
