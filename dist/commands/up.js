import chalk from "chalk";
import ora from "ora";
import { execSync, spawn } from "child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { api, streamSSE, getBaseURL, APIError } from "../lib/api.js";
import { updateProjectLink } from "../lib/config.js";
import { resolveContext, getScope } from "../lib/resolve.js";
import { ensureLinked } from "./init.js";
import { success, info, error, isJSONMode, isTTY, printJSON, statusColor, } from "../lib/format.js";
/**
 * Builds the `up` command:
 *   - upload local code (or `[path]`) as a tarball
 *   - target a service via --service / linked / first-in-project
 *   - --ci streams build logs only and exits when build finishes
 *   - --detach returns immediately after upload
 */
export function registerUp(program) {
    const up = program
        .command("up")
        .description("Upload and deploy code to Lizard")
        .argument("[path]", "Path to deploy (default: current directory)")
        .option("-d, --detach", "Don't attach to the log stream")
        .option("-c, --ci", "Stream build logs only, exit on completion")
        .option("-s, --service <name>", "Service to deploy to (defaults to linked)")
        .option("-p, --project <id>", "Project name, slug, or ID")
        .option("--no-gitignore", "Don't ignore paths from .gitignore")
        .option("--region <code>", "Region to create the service in (new services only)")
        .option("--build-command <cmd>", "Build command to run (e.g. 'npm run build')")
        .option("--start-command <cmd>", "Start command to run (e.g. 'node dist/index.js')")
        .option("--pre-deploy-command <cmd>", "Pre-deploy command (e.g. 'node dist/migrate.js')")
        .option("--port <number>", "Container port (default: 3000; 0 = worker mode, no HTTP listener)")
        .action(async (pathArg, opts, cmd) => {
        const merged = cmd.optsWithGlobals();
        const serviceFlag = merged.service ?? opts.service;
        const projectFlag = merged.project;
        const region = opts.region;
        // Run init flow if cwd isn't linked yet
        await ensureLinked({ projectName: projectFlag });
        // Resolve target service: --service flag → linked → first-in-project → prompt-or-fail
        const ctx = await resolveContext({
            projectFlag,
            serviceFlag,
        });
        const projectId = ctx.projectId;
        const scope = getScope(ctx);
        const targetPath = pathArg ? path.resolve(pathArg) : process.cwd();
        // `up` always uploads a local tarball. For redeploy of an existing
        // build without re-uploading, use `lizard redeploy`.
        await deployFromLocal({
            projectId,
            scope,
            targetPath,
            useGitignore: opts.gitignore !== false,
            serviceFlag,
            existingServiceId: ctx.service?.id,
            region,
            buildCommand: opts.buildCommand,
            startCommand: opts.startCommand,
            preDeployCommand: opts.preDeployCommand,
            // Use undefined check, not truthy — "0" is worker mode and must reach the server.
            port: opts.port !== undefined ? parseInt(opts.port, 10) : undefined,
            opts,
        });
    });
    // `lizard up status <id>` — show build/deploy status
    up
        .command("status")
        .argument("<id>", "App or deploy ID")
        .description("Show deployment status")
        .action(async (id) => {
        const app = await api.get(`/api/apps/${id}`);
        if (isJSONMode()) {
            printJSON(app);
            return;
        }
        console.log(`${chalk.bold(app.name)}  ${statusColor(app.status)}`);
        if (app.domain)
            console.log(`  URL: ${chalk.cyan(`https://${app.domain}`)}`);
        if (app.builds?.length)
            console.log(`  Latest build: ${statusColor(app.builds[0].status)}`);
    });
}
// ── deploy strategies ────────────────────────────────────────────────────────
async function deployFromLocal(args) {
    const defaultName = args.serviceFlag || getDefaultAppName(args.targetPath);
    info(`${args.existingServiceId ? "Uploading" : "Creating service from"} ${chalk.dim(args.targetPath)}`);
    let appName = args.serviceFlag || defaultName;
    if (!args.existingServiceId && !args.serviceFlag && isTTY()) {
        const nameInput = await prompt(`Service name [${defaultName}]: `);
        appName = nameInput || defaultName;
    }
    const files = getUploadFiles(args.targetPath, args.useGitignore);
    if (files.length === 0) {
        throw new Error("No files to upload. Run from a directory with files, or pass a path: `lizard up <path>`.");
    }
    info(chalk.dim(`  ${files.length} files selected`));
    const detectedPort = args.port === undefined ? detectLocalPort(args.targetPath) : undefined;
    if (detectedPort)
        info(`Detected port ${chalk.bold(detectedPort)} from Dockerfile`);
    const tarball = await createTarball(files, args.targetPath);
    info(chalk.dim(`  Tarball: ${(tarball.length / 1024 / 1024).toFixed(1)} MB`));
    const spinner = ora("Uploading...").start();
    let newApp;
    try {
        const resolvedPort = args.port ?? detectedPort;
        const qs = new URLSearchParams();
        // Only send port when explicitly given or detected — lets server keep the stored
        // containerPort on redeploy instead of overwriting it with the 3000 default.
        if (resolvedPort !== undefined)
            qs.set("port", String(resolvedPort));
        if (!args.existingServiceId) {
            qs.set("name", appName);
            if (args.region)
                qs.set("region", args.region);
            // New services with no detected port default to 3000
            if (resolvedPort === undefined)
                qs.set("port", "3000");
        }
        if (args.existingServiceId)
            qs.set("appId", args.existingServiceId);
        if (args.buildCommand)
            qs.set("buildCommand", args.buildCommand);
        if (args.startCommand)
            qs.set("startCommand", args.startCommand);
        if (args.preDeployCommand)
            qs.set("preDeployCommand", args.preDeployCommand);
        if (args.scope.workspaceId)
            qs.set("workspaceId", args.scope.workspaceId);
        const url = `${getBaseURL()}/api/projects/${args.projectId}/apps/upload?${qs.toString()}`;
        const res = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/octet-stream",
                Authorization: `Bearer ${(await import("../lib/auth.js")).getToken()}`,
            },
            body: tarball.buffer,
        });
        if (!res.ok) {
            // Parse the JSON error envelope when present so structured failures
            // (e.g. the trashed-project write guard's 409) survive to the central
            // handler; fall back to raw text for non-JSON bodies.
            const text = await res.text();
            let parsed = null;
            try {
                parsed = text ? JSON.parse(text) : null;
            }
            catch { }
            const detail = parsed?.error || parsed?.message || text || res.statusText;
            throw new APIError(res.status, `Upload failed (${res.status}): ${detail}`, parsed?.code || "", parsed);
        }
        newApp = (await res.json());
        spinner.succeed(`Service ${chalk.bold(newApp.name)} ${args.existingServiceId ? "updated" : "created"}`);
    }
    catch (err) {
        spinner.fail("Upload failed");
        throw err;
    }
    saveServiceToConfig(args.projectId, newApp.id, newApp.name);
    if (args.opts.detach) {
        isJSONMode()
            ? printJSON({ appId: newApp.id, version: 1, status: "deploying" })
            : success(`Deploy started  ${chalk.dim(`lizard up status ${newApp.id}`)}`);
        return;
    }
    await streamBuildLogs(newApp.id, args.opts.ci, newApp.buildId);
}
// ── helpers ──────────────────────────────────────────────────────────────────
function saveServiceToConfig(_projectId, serviceId, serviceName) {
    try {
        updateProjectLink({ serviceId, serviceName });
    }
    catch { }
}
function getDefaultAppName(cwd = process.cwd()) {
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8"));
        if (pkg.name)
            return pkg.name.replace(/^@[^/]+\//, "");
    }
    catch { }
    return path.basename(cwd);
}
function getUploadFiles(cwd, useGitignore) {
    if (useGitignore) {
        try {
            // `-z` outputs NUL-separated paths and disables git's default behaviour
            // of double-quoting names with unusual characters. Without it, a file
            // called `weird\nname.txt` would either get quoted (and never matched
            // by tar) or split the listing across newlines.
            const tracked = execSync("git ls-files -z", {
                cwd,
                stdio: ["pipe", "pipe", "pipe"],
            })
                .toString("utf8")
                .split("\0")
                .filter(Boolean);
            const untracked = execSync("git ls-files --others --exclude-standard -z", {
                cwd,
                stdio: ["pipe", "pipe", "pipe"],
            })
                .toString("utf8")
                .split("\0")
                .filter(Boolean);
            return [...new Set([...tracked, ...untracked])];
        }
        catch {
            // fall through to manual collection
        }
    }
    return collectFilesManually(cwd, cwd);
}
const EXCLUDE_DIRS = new Set([
    "node_modules",
    ".git",
    "dist",
    ".next",
    "build",
    "__pycache__",
    ".venv",
    "venv",
    ".cache",
    "coverage",
    ".turbo",
    ".vercel",
]);
const EXCLUDE_EXT = new Set([".pyc", ".pyo", ".log"]);
// Matched by full name — `path.extname(".DS_Store")` is "" (dotfile), so
// extension matching never catches these.
const EXCLUDE_FILES = new Set([".DS_Store"]);
function collectFilesManually(root, dir) {
    const results = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (EXCLUDE_DIRS.has(entry.name))
            continue;
        if (EXCLUDE_FILES.has(entry.name))
            continue;
        if (EXCLUDE_EXT.has(path.extname(entry.name)))
            continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory())
            results.push(...collectFilesManually(root, full));
        else
            results.push(path.relative(root, full));
    }
    return results;
}
function createTarball(files, cwd) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        // `--null` makes tar read NUL-separated paths from stdin, matching what
        // `git ls-files -z` writes. Newline-separated input would split filenames
        // containing `\n` across multiple entries. Both bsdtar (macOS) and GNU
        // tar accept `--null` before `-T -`.
        const tar = spawn("tar", ["--null", "-czf", "-", "-T", "-"], { cwd });
        tar.stdout.on("data", (c) => chunks.push(c));
        tar.stderr.on("data", () => { });
        tar.on("close", (code) => {
            if (code === 0) {
                const total = chunks.reduce((n, c) => n + c.length, 0);
                const out = new Uint8Array(total);
                let off = 0;
                for (const c of chunks) {
                    out.set(c, off);
                    off += c.length;
                }
                resolve(out);
            }
            else {
                reject(new Error(`tar exited ${code}`));
            }
        });
        if (files.length > 0)
            tar.stdin.write(files.join("\0") + "\0");
        tar.stdin.end();
    });
}
function detectLocalPort(dir) {
    for (const name of ["Dockerfile", "dockerfile", "Dockerfile.production"]) {
        try {
            const text = fs.readFileSync(path.join(dir, name), "utf8");
            const match = text.match(/^EXPOSE\s+(\d+)/m);
            if (match)
                return parseInt(match[1], 10);
        }
        catch { }
    }
    return undefined;
}
function prompt(question) {
    return new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question(question, (answer) => {
            rl.close();
            resolve(answer.trim());
        });
    });
}
async function streamBuildLogs(appId, ciMode = false, knownBuildId) {
    // Prefer the buildId returned by the upload/redeploy response — polling
    // builds[0] races against a still-running previous build and can attach
    // to the wrong one.
    let buildId = knownBuildId ?? null;
    if (!buildId) {
        const spinner = ora("Waiting for build...").start();
        for (let i = 0; i < 30; i++) {
            await sleep(2000);
            try {
                const app = await api.get(`/api/apps/${appId}`);
                if (app.builds?.length) {
                    const latest = app.builds[0];
                    if (["building", "deploying", "running", "failed"].includes(latest.status)) {
                        buildId = latest.id;
                        break;
                    }
                }
            }
            catch { }
        }
        spinner.stop();
    }
    if (!buildId) {
        info(chalk.dim("No build found. Check `lizard up status <id>`."));
        return;
    }
    info(chalk.dim("Streaming build logs...\n"));
    // Stream with auto-reconnect — connections can drop mid-build (Cloudflare
    // idle timeout, network blips). Reconnect until the build itself reports
    // a terminal status, with a hard cap so we don't loop forever.
    const deadline = Date.now() + 15 * 60 * 1000; // 15 min max
    while (Date.now() < deadline) {
        let dropped = false;
        try {
            await streamSSE(`/api/builds/${buildId}/logs`, (event, data) => {
                if (event === "done" || event === "error") {
                    if (event === "error")
                        emitBuildError(data);
                    else
                        emitBuildDone();
                    return false;
                }
                emitBuildLine(data);
                return true;
            });
        }
        catch {
            dropped = true;
        }
        // Whether we got a clean SSE end or a dropped connection, check the
        // build state — terminal status means we stop reconnecting.
        try {
            const build = await api.get(`/api/builds/${buildId}`);
            if (build.status === "done" || build.status === "failed")
                break;
        }
        catch { }
        if (!dropped)
            break; // clean SSE end — don't reconnect
        await sleep(2000);
    }
    if (ciMode)
        return;
    const app = await api.get(`/api/apps/${appId}`);
    if (app.status === "running") {
        if (isJSONMode()) {
            process.stdout.write(JSON.stringify({
                event: "deployed",
                status: "running",
                url: app.domain ? `https://${app.domain}` : null,
            }) + "\n");
        }
        else {
            success(`Deployed! ${app.domain ? chalk.cyan(`https://${app.domain}`) : ""}`);
        }
    }
    else if (app.status === "failed") {
        if (isJSONMode()) {
            process.stdout.write(JSON.stringify({ event: "failed", status: "failed" }) + "\n");
        }
        else {
            error("Deploy failed. Check logs with `lizard logs --build`");
        }
    }
    else if (app.status === "deploying") {
        if (isJSONMode()) {
            process.stdout.write(JSON.stringify({ event: "deploying", status: "deploying" }) + "\n");
        }
        else {
            info(chalk.dim("Still deploying... check status with `lizard ps`"));
        }
    }
}
// ── build stream emitters ────────────────────────────────────────────────────
function emitBuildLine(data) {
    let parsed;
    try {
        parsed = JSON.parse(data);
    }
    catch {
        parsed = { line: data };
    }
    if (typeof parsed === "string")
        parsed = { line: parsed };
    const line = parsed.line ?? parsed.message ?? "";
    if (isJSONMode()) {
        process.stdout.write(JSON.stringify({ event: "log", line, ...stripLine(parsed) }) + "\n");
        return;
    }
    if (line)
        process.stdout.write(line + "\n");
    else
        process.stdout.write(data + "\n");
}
function stripLine(obj) {
    const { line: _l, message: _m, ...rest } = obj;
    return rest;
}
function emitBuildDone() {
    if (isJSONMode()) {
        process.stdout.write(JSON.stringify({ event: "done" }) + "\n");
    }
    else {
        success("Build complete");
    }
}
function emitBuildError(data) {
    if (isJSONMode()) {
        process.stdout.write(JSON.stringify({ event: "error", message: data }) + "\n");
    }
    else {
        error(`Build failed: ${data}`);
    }
}
function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
//# sourceMappingURL=up.js.map