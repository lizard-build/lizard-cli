import chalk from "chalk";
import * as p from "@clack/prompts";
import * as fs from "node:fs";
import { api } from "../lib/api.js";
import { resolveProjectId } from "../lib/config.js";
import { resolveService } from "../lib/resolve.js";
import { success, info, isJSONMode, printJSON, isTTY } from "../lib/format.js";
/**
 * `lizard service set` — atomic patch of per-service configuration.
 *
 * Three input modes (priority):
 *   1. -s <SERVICE> <DOT_PATH> <VALUE>  — repeatable Railway-style flags
 *   2. -f <file>                         — read JSON from file
 *   3. piped stdin JSON                  — auto-detected when stdin has data
 *   4. interactive                       — TTY prompts when nothing else is given
 *
 * Dot-paths supported:
 *   build.builder              "RAILPACK" | "DOCKERFILE"
 *   build.buildCommand         string
 *   build.watchPatterns        string[] (JSON array or comma-separated)
 *   build.dockerfilePath       string
 *   deploy.startCommand        string
 *   deploy.healthcheckPath     string
 *   deploy.healthcheckTimeout  number
 *   deploy.numReplicas         number
 *   deploy.restartPolicyType   "ON_FAILURE" | "ALWAYS" | "NEVER"
 *   source.repo                string
 *   source.branch              string
 *   source.image               string
 *   source.rootDirectory       string
 *   variables.<KEY>.value      string (supports ${{...}} references)
 */
export function registerServiceSet(svc) {
    svc
        .command("set")
        .description("Apply build/start/watch/variable changes to one or more services")
        .option("-f, --file <path>", "JSON config file to apply")
        .option("-s, --service-config <args...>", "Repeatable: <SERVICE> <DOT_PATH> <VALUE>")
        .option("-m, --message <text>", "Commit message for the changes")
        .option("--stage", "Stage changes without committing")
        .option("-p, --project <id>", "Project name or ID")
        .action(async (opts) => {
        const projectId = resolveProjectId(opts.project);
        const patch = await buildPatch(opts, projectId);
        if (!patch || isEmpty(patch)) {
            if (isJSONMode()) {
                printJSON({ staged: false, committed: false, message: "No changes" });
            }
            else {
                info(chalk.yellow("No changes to apply"));
            }
            return;
        }
        const result = await api
            .post(`/api/projects/${projectId}/config:apply`, {
            patch,
            message: opts.message,
            stage: Boolean(opts.stage),
        })
            .catch((err) => {
            if (err?.status === 404) {
                throw new Error("Config-apply endpoint not yet implemented. The API needs " +
                    "`POST /api/projects/{id}/config:apply` with body { patch, message, stage }, " +
                    "or `PATCH /api/apps/{id}` per service.");
            }
            throw err;
        });
        if (isJSONMode()) {
            printJSON({
                staged: result?.staged ?? Boolean(opts.stage),
                committed: result?.committed ?? !opts.stage,
                message: opts.message,
                diff: result?.diff,
            });
            return;
        }
        if (opts.stage) {
            success(`Changes staged` +
                chalk.dim(" (commit with `lizard service set` again)"));
        }
        else {
            success(`Service configuration applied` +
                (opts.message ? chalk.dim(` (${opts.message})`) : ""));
        }
    });
}
// ── input handling ──────────────────────────────────────────────────────────
async function buildPatch(opts, projectId) {
    // 1. -s <SERVICE> <DOT_PATH> <VALUE> repeatable
    if (opts.serviceConfig?.length) {
        return await flagsToPatch(opts.serviceConfig, projectId);
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
        return await interactivePatch(projectId);
    }
    return null;
}
function readStdin() {
    return new Promise((resolve, reject) => {
        const chunks = [];
        process.stdin.on("data", (c) => chunks.push(c));
        process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
        process.stdin.on("error", reject);
    });
}
/** Returns true only when stdin is a piped/file source with bytes ready. */
function stdinHasData() {
    return new Promise((resolve) => {
        if (process.stdin.isTTY)
            return resolve(false);
        const stdin = process.stdin;
        let answered = false;
        const finish = (v) => {
            if (answered)
                return;
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
async function normalisePatch(raw, projectId) {
    const root = raw.services ?? raw.apps ?? raw;
    if (typeof root !== "object" || Array.isArray(root)) {
        throw new Error("Config must be an object keyed by service name or ID.");
    }
    const services = {};
    for (const [key, value] of Object.entries(root)) {
        const svc = await resolveService(projectId, key);
        services[svc.id] = value;
    }
    const out = { services };
    if (raw.sharedVariables)
        out.sharedVariables = raw.sharedVariables;
    if (raw.volumes)
        out.volumes = raw.volumes;
    return out;
}
/** Convert a flat (service, dotPath, value) list into a nested patch. */
async function flagsToPatch(flat, projectId) {
    if (flat.length % 3 !== 0) {
        throw new Error("--service-config expects triples: <SERVICE> <DOT_PATH> <VALUE>");
    }
    const services = {};
    for (let i = 0; i < flat.length; i += 3) {
        const [svcRef, dotPath, rawValue] = [flat[i], flat[i + 1], flat[i + 2]];
        const svc = await resolveService(projectId, svcRef);
        const value = parseValue(dotPath, rawValue);
        services[svc.id] = services[svc.id] || {};
        setDeep(services[svc.id], dotPath, value);
    }
    return { services };
}
/** Interactive prompt loop. Pick service → pick field → enter value. */
async function interactivePatch(projectId) {
    const data = await api.get(`/api/projects/${projectId}/services`);
    const services = [...(data.apps || []), ...(data.addons || [])];
    if (services.length === 0) {
        throw new Error("No services in project. Use `lizard add` first.");
    }
    const out = {};
    while (true) {
        const svcId = await p.select({
            message: "Configure which service?",
            options: [
                ...services.map((s) => ({
                    value: s.id,
                    label: s.name,
                    hint: s.status,
                })),
                { value: "__done__", label: "Done — apply changes" },
            ],
        });
        if (p.isCancel(svcId) || svcId === "__done__")
            break;
        const field = await p.select({
            message: "What to change?",
            options: [
                { value: "deploy.startCommand", label: "Start command" },
                { value: "build.buildCommand", label: "Build command" },
                { value: "build.watchPatterns", label: "Watch patterns" },
                { value: "build.builder", label: "Builder (RAILPACK/DOCKERFILE)" },
                { value: "build.dockerfilePath", label: "Dockerfile path" },
                { value: "deploy.healthcheckPath", label: "Healthcheck path" },
                { value: "deploy.numReplicas", label: "Replicas" },
                { value: "deploy.restartPolicyType", label: "Restart policy" },
                { value: "source.rootDirectory", label: "Root directory" },
                { value: "source.repo", label: "GitHub repo" },
                { value: "source.image", label: "Docker image" },
            ],
        });
        if (p.isCancel(field))
            break;
        const valueInput = await p.text({
            message: `${field}`,
            placeholder: field === "build.watchPatterns"
                ? "comma-separated or JSON array"
                : "value",
        });
        if (p.isCancel(valueInput))
            break;
        const parsed = parseValue(field, String(valueInput));
        out[svcId] = out[svcId] || {};
        setDeep(out[svcId], field, parsed);
    }
    return { services: out };
}
// ── value coercion ──────────────────────────────────────────────────────────
function parseValue(dotPath, raw) {
    if (dotPath === "deploy.numReplicas" ||
        dotPath === "deploy.healthcheckTimeout" ||
        dotPath === "deploy.restartPolicyMaxRetries") {
        const n = Number(raw);
        if (Number.isNaN(n))
            throw new Error(`${dotPath} expects a number, got "${raw}"`);
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
            }
            catch {
                throw new Error(`Invalid JSON array for ${dotPath}: ${raw}`);
            }
        }
        return trimmed.split(",").map((s) => s.trim()).filter(Boolean);
    }
    const trimmed = raw.trim();
    if ((trimmed.startsWith("{") && trimmed.endsWith("}")) ||
        (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
        try {
            return JSON.parse(trimmed);
        }
        catch {
            // store as string
        }
    }
    return raw;
}
function setDeep(obj, dotPath, value) {
    const keys = dotPath.split(".");
    let cur = obj;
    for (let i = 0; i < keys.length - 1; i++) {
        const k = keys[i];
        if (typeof cur[k] !== "object" || cur[k] === null)
            cur[k] = {};
        cur = cur[k];
    }
    cur[keys[keys.length - 1]] = value;
}
function isEmpty(obj) {
    if (!obj || typeof obj !== "object")
        return true;
    if (Array.isArray(obj))
        return obj.length === 0;
    if (obj.services && Object.keys(obj.services).length === 0)
        return true;
    return Object.keys(obj).length === 0;
}
//# sourceMappingURL=service-set.js.map