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
 * Field names are flat and match the wire schema of `POST /config:apply`
 * exactly. There is no nested {build,deploy,source} grouping anywhere in the
 * system — DB columns, REST schemas, node-agent payloads, and `service show`
 * output are all flat. See SERVICE_FIELDS below for the full list.
 *
 * Namespaces (variables.*, secrets.*, sharedVariables) are kept because they
 * really are separate stores (per-service / project-wide env), not flat
 * service-config fields.
 */

/**
 * Canonical service-config fields accepted by `--set` and as keys in a `-f`
 * file's cfg blob. Mirrors `configApplySchema.serviceConfigSchema` in
 * dragonlabs-platform/server/src/routes/projects.ts.
 */
export const SERVICE_FIELDS = [
  "name", // rename target — only sent when it differs from current
  "sourceType",
  "repoUrl",
  "branch",
  "rootDirectory",
  "buildCommand",
  "watchPatterns",
  "dockerfilePath",
  "startCommand",
  "preDeployCommand",
  "healthcheckPath",
  "healthcheckTimeoutMs",
] as const;

const SERVICE_FIELD_SET: ReadonlySet<string> = new Set(SERVICE_FIELDS);
const NUMERIC_FIELDS: ReadonlySet<string> = new Set(["healthcheckTimeoutMs"]);
const STRING_ARRAY_FIELDS: ReadonlySet<string> = new Set(["watchPatterns"]);

/** Per-service "namespace" keys — not flat fields, separate stores. */
const NAMESPACE_KEYS: ReadonlySet<string> = new Set(["variables", "envVars"]);

/** Allowed top-level keys in a `-f` / stdin JSON payload. */
const TOP_LEVEL_KEYS: ReadonlySet<string> = new Set([
  "services",
  "apps",
  "sharedVariables",
  "secrets",
]);

/**
 * Service-name rule mirrored from dragonlabs-platform
 * (server/src/services/var-transform.ts::NAME_REGEX).
 * LIZARD-55: 1–40 chars, lowercase a–z / digits / hyphens, can't start or
 * end with a hyphen.
 */
const NAME_REGEX = /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/;
const NAME_HINT =
  "1–40 chars, lowercase a–z, digits, hyphens; can't start or end with a hyphen";

export function validateName(name: string): string | null {
  if (!name) return "name is required";
  if (name.length > 40) return "name must be 40 characters or fewer";
  if (!NAME_REGEX.test(name)) return `invalid name (${NAME_HINT})`;
  return null;
}

export function registerServiceSet(svc: Command) {
  svc
    .command("set")
    .description(
      "Apply build/start/health/source/variables/rename changes to a service",
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
    .addHelpText("after", `
Supported --set fields (flat — matches the wire schema and \`service show\`):
  name                        rename the service (lowercase a-z, digits, hyphens; 1-40 chars)
  sourceType                  github | upload
  repoUrl                     string  (e.g. https://github.com/acme/api)
  branch                      string
  rootDirectory               string  (monorepo subpath)
  buildCommand                string  (e.g. "npm run build")
  watchPatterns               string[] — comma-separated or JSON array
  dockerfilePath              string  (path to Dockerfile, enables docker build)
  startCommand                string  (e.g. "node dist/index.js")
  preDeployCommand            string  (runs once before each rollout, e.g. migrations)
  healthcheckPath             string  (HTTP path, e.g. /health)
  healthcheckTimeoutMs        number  (milliseconds)

  variables.<KEY>             string  (per-service env shortcut)
  variables.<KEY>.value       string  (supports \${{ <ref>.KEY }} templates)

Notes:
  Use -f <file> or pipe JSON on stdin for multi-service patches.
  --set requires a service argument; pairs are repeatable.
  'variables.*' are stored as per-service secrets (same runtime env as
  'lizard secrets set --service <name>'). To set project-wide env, use
  'lizard secrets set --global' or pass JSON with a top-level
  'sharedVariables' / 'secrets.shared' block via -f / stdin.
  Rename ('--set name=...') cannot be combined with secret updates in the
  same call — split into two calls.

Examples:
  lizard service set api --set startCommand="node dist/index.js"
  lizard service set api --set buildCommand="npm run build" --set healthcheckPath=/health
  lizard service set api --set name=api-v2
  lizard service set api --set variables.PORT=3000
  lizard service set api --set variables.DB_URL.value='\${{ postgres.DATABASE_URL }}'
  lizard service set -f lizard-config.json`)
    .action(async (serviceArg: string | undefined, opts) => {
      const { projectId, scope } = await resolveProjectScope(opts.project);

      const patch = await buildPatch(serviceArg || opts.service, opts, projectId, scope);
      if (!patch || isPatchEmpty(patch)) {
        if (isJSONMode()) {
          printJSON({ staged: false, committed: false, message: "No changes" });
        } else {
          info(chalk.yellow("No changes to apply"));
        }
        return;
      }

      // Resolve current service names for: rename detection, error messages,
      // and per-service-secret keying. One call, reused.
      const nameById = await fetchNameIndex(projectId, scope, Object.keys(patch.services));

      const body = flattenPatch(patch, nameById);
      validateNoRenameWithSecrets(body, nameById);

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

// ── pure transforms (exported for tests) ─────────────────────────────────────

/**
 * Convert a normalised patch (services keyed by id, flat cfg blobs) into the
 * wire body for `POST /api/projects/:id/config:apply`:
 *
 *   { services: [{ id, name?, buildCommand?, startCommand?, ... }],
 *     secrets?: { shared?, services? } }
 *
 * `nameById` provides the current display name for each service id. Rename
 * fires only when cfg.name is set AND differs from current — equal names
 * are silently dropped so non-rename calls don't bloat the audit log.
 *
 * Unknown fields in cfg throw before any network call.
 */
export function flattenPatch(
  patch: any,
  nameById: Map<string, string>,
): { services: any[]; secrets?: any } {
  const out: { services: any[]; secrets?: any } = { services: [] };
  if (!patch || typeof patch !== "object") return out;

  const services = patch.services ?? {};

  for (const [id, cfgRaw] of Object.entries(services)) {
    const currentName = nameById.get(id);
    if (!currentName) {
      throw new Error(`Service ${id} no longer exists in the project.`);
    }

    const cfg =
      cfgRaw && typeof cfgRaw === "object" && !Array.isArray(cfgRaw)
        ? (cfgRaw as Record<string, unknown>)
        : {};

    rejectUnknownServiceFields(cfg, currentName);

    const flat: Record<string, unknown> = { id };

    if (cfg.name !== undefined && cfg.name !== currentName) {
      const reason = validateName(String(cfg.name));
      if (reason) {
        throw new Error(`Invalid 'name' for service "${currentName}": ${reason}`);
      }
      flat.name = cfg.name;
    }

    for (const f of SERVICE_FIELDS) {
      if (f === "name") continue;
      if (cfg[f] !== undefined) flat[f] = cfg[f];
    }

    const svcVars = collectKv(cfg.variables);
    if (cfg.envVars && typeof cfg.envVars === "object") {
      for (const [k, v] of Object.entries(cfg.envVars as Record<string, unknown>)) {
        svcVars[k] = v == null ? null : String(v);
      }
    }
    if (Object.keys(svcVars).length > 0) {
      mergeServiceSecrets(out, currentName, svcVars);
    }

    out.services.push(flat);
  }

  if (patch.sharedVariables) {
    mergeSharedSecrets(out, collectKv(patch.sharedVariables));
  }
  if (patch.secrets?.services) {
    for (const [svcName, kv] of Object.entries(patch.secrets.services)) {
      mergeServiceSecrets(out, svcName, kv as Record<string, string | null>);
    }
  }
  if (patch.secrets?.shared) {
    mergeSharedSecrets(out, patch.secrets.shared);
  }

  return out;
}

/**
 * Reject a wire body that combines a rename with per-service secret updates.
 * The backend's `secrets.services[<name>]` lookup uses a pre-rename snapshot
 * of the apps table, so a rename + secrets-by-new-name in one call fails
 * with "Unknown services in secrets". Catch it client-side with a clearer
 * message before sending.
 */
export function validateNoRenameWithSecrets(
  body: { services: any[]; secrets?: any },
  nameById: Map<string, string>,
) {
  const renames: string[] = [];
  for (const s of body.services) {
    if (s.name !== undefined && s.name !== nameById.get(s.id)) {
      renames.push(`${nameById.get(s.id)} → ${s.name}`);
    }
  }
  if (renames.length === 0) return;

  const hasServiceSecrets =
    body.secrets?.services && Object.keys(body.secrets.services).length > 0;
  if (!hasServiceSecrets) return;

  throw new Error(
    `Cannot combine a service rename (${renames.join(", ")}) with per-service ` +
      `secret updates in the same call. Backend keys per-service secrets by name ` +
      `from a pre-rename snapshot, which fails on conflict. ` +
      `Split into two calls: rename first, then update secrets.`,
  );
}

function rejectUnknownServiceFields(
  cfg: Record<string, unknown>,
  serviceName: string,
) {
  for (const key of Object.keys(cfg)) {
    if (SERVICE_FIELD_SET.has(key)) continue;
    if (NAMESPACE_KEYS.has(key)) continue;
    throw new Error(
      `Unknown field '${key}' in service "${serviceName}". ` +
        `See 'lizard service set --help' for the list of supported fields.`,
    );
  }
}

/** Convert `{ KEY: "v" | { value: "v" } | null }` to a flat `{ KEY: "v" | null }`. */
function collectKv(src: unknown): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  if (!src || typeof src !== "object") return out;
  for (const [k, raw] of Object.entries(src as Record<string, unknown>)) {
    if (raw == null) {
      out[k] = null;
      continue;
    }
    out[k] =
      typeof raw === "object" && "value" in (raw as Record<string, unknown>)
        ? String((raw as Record<string, unknown>).value)
        : String(raw);
  }
  return out;
}

function mergeServiceSecrets(
  out: { secrets?: any },
  serviceName: string,
  kv: Record<string, string | null>,
) {
  out.secrets ??= {};
  out.secrets.services ??= {};
  out.secrets.services[serviceName] = {
    ...(out.secrets.services[serviceName] || {}),
    ...kv,
  };
}

function mergeSharedSecrets(
  out: { secrets?: any },
  kv: Record<string, string | null>,
) {
  out.secrets ??= {};
  out.secrets.shared = { ...(out.secrets.shared || {}), ...kv };
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
      throw new Error(
        "Service name is required when using --set. Usage: lizard service set <service> --set <path>=<value>  (or -s <service>)",
      );
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
 * Normalise a raw JSON payload (`-f` / stdin):
 *   { services: { name|id: { <flat cfg> } } }
 *   { apps: { name|id: { <flat cfg> } } }                   // alias
 *   { name|id: { <flat cfg> } }                              // shortcut (no siblings)
 *   plus optional top-level: sharedVariables, secrets
 *
 * Unknown top-level keys throw. Per-service cfg validation happens in
 * `flattenPatch` once we know the current service name.
 */
async function normalisePatch(raw: any, projectId: string): Promise<any> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Config must be a JSON object.");
  }

  const hasExplicitServices = "services" in raw || "apps" in raw;
  const hasSiblings = "sharedVariables" in raw || "secrets" in raw;

  if (!hasExplicitServices && hasSiblings) {
    throw new Error(
      "Cannot use shortcut form alongside 'sharedVariables'/'secrets'. " +
        "Wrap services in a top-level 'services' key.",
    );
  }

  if (hasExplicitServices) {
    for (const k of Object.keys(raw)) {
      if (!TOP_LEVEL_KEYS.has(k)) {
        throw new Error(
          `Unknown top-level field '${k}'. ` +
            `Allowed: ${Array.from(TOP_LEVEL_KEYS).join(", ")}.`,
        );
      }
    }
  }

  const root: any = raw.services ?? raw.apps ?? raw;
  if (typeof root !== "object" || Array.isArray(root)) {
    throw new Error("'services' must be an object keyed by service name or ID.");
  }

  const services: Record<string, any> = {};
  for (const [key, value] of Object.entries(root)) {
    const svc = await resolveService(projectId, key);
    services[svc.id] = value;
  }

  const out: any = { services };
  if (raw.sharedVariables) out.sharedVariables = raw.sharedVariables;
  if (raw.secrets) out.secrets = raw.secrets;
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
      throw new Error(`--set expects <path>=<value>, got "${pair}"`);
    }
    const dotPath = pair.slice(0, eq).trim();
    const rawValue = pair.slice(eq + 1);
    validateSetPath(dotPath);
    const value = parseValue(dotPath, rawValue);
    setDeep(cfg, dotPath, value);
  }

  return { services: { [svc.id]: cfg } };
}

/** Validate a `--set` dot-path against the canonical (flat) field list and
 *  the `variables.*` namespace. Throws on anything else. */
export function validateSetPath(dotPath: string) {
  if (SERVICE_FIELD_SET.has(dotPath)) return;
  if (dotPath.startsWith("variables.")) {
    const parts = dotPath.split(".");
    // variables.KEY  or  variables.KEY.value
    if (parts.length === 2 && parts[1]) return;
    if (parts.length === 3 && parts[1] && parts[2] === "value") return;
    throw new Error(
      `Invalid --set path '${dotPath}'. ` +
        `Use 'variables.<KEY>' or 'variables.<KEY>.value'.`,
    );
  }
  throw new Error(
    `Unknown --set field '${dotPath}'. ` +
      `See 'lizard service set --help' for the list of supported fields.`,
  );
}

/** Interactive prompt loop. Pick service → pick field → enter value. */
async function interactivePatch(
  projectId: string,
  scope: ResourceScope,
): Promise<any> {
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
        { value: "startCommand", label: "Start command" },
        { value: "preDeployCommand", label: "Pre-deploy command" },
        { value: "buildCommand", label: "Build command" },
        { value: "watchPatterns", label: "Watch patterns" },
        { value: "dockerfilePath", label: "Dockerfile path" },
        { value: "healthcheckPath", label: "Healthcheck path" },
        { value: "healthcheckTimeoutMs", label: "Healthcheck timeout (ms)" },
        { value: "sourceType", label: "Source type (github/upload)" },
        { value: "branch", label: "Branch" },
        { value: "rootDirectory", label: "Root directory" },
        { value: "repoUrl", label: "GitHub repo" },
        { value: "name", label: "Rename service" },
      ],
    });
    if (p.isCancel(field)) break;

    const valueInput = await p.text({
      message: `${field}`,
      placeholder:
        field === "watchPatterns"
          ? "comma-separated or JSON array"
          : field === "name"
            ? "new-service-name"
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

export function parseValue(dotPath: string, raw: string): unknown {
  if (NUMERIC_FIELDS.has(dotPath)) {
    const n = Number(raw);
    if (Number.isNaN(n)) {
      throw new Error(`${dotPath} expects a number, got "${raw}"`);
    }
    return n;
  }

  if (STRING_ARRAY_FIELDS.has(dotPath)) {
    const trimmed = raw.trim();
    if (trimmed.startsWith("[")) {
      try {
        return JSON.parse(trimmed);
      } catch {
        throw new Error(`Invalid JSON array for ${dotPath}: ${raw}`);
      }
    }
    return trimmed
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
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

export function setDeep(
  obj: Record<string, any>,
  dotPath: string,
  value: unknown,
) {
  const keys = dotPath.split(".");
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    if (typeof cur[k] !== "object" || cur[k] === null) cur[k] = {};
    cur = cur[k];
  }
  cur[keys[keys.length - 1]] = value;
}

function isPatchEmpty(patch: any): boolean {
  if (!patch || typeof patch !== "object") return true;
  if (patch.services && Object.keys(patch.services).length === 0) {
    return !patch.sharedVariables && !patch.secrets;
  }
  return false;
}

// ── network helpers ─────────────────────────────────────────────────────────

/**
 * Fetch current display names for each service id in the patch. Reused for
 * rename detection (current vs cfg.name) and per-service-secret keying.
 */
async function fetchNameIndex(
  projectId: string,
  scope: ResourceScope,
  ids: string[],
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const data = await api.get<{ apps?: any[]; addons?: any[] }>(
    withScope(`/api/projects/${projectId}/services`, scope),
  );
  const all = [...(data.apps || []), ...(data.addons || [])];
  return new Map(all.map((s: any) => [s.id, s.name]));
}
