import chalk from "chalk";
import ora from "ora";
import { execSync, spawn } from "child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { api, streamSSE, getBaseURL } from "../lib/api.js";
import { updateProjectLink } from "../lib/config.js";
import { resolveContext } from "../lib/resolve.js";
import { ensureLinked } from "./init.js";
import { success, info, error, isJSONMode, printJSON, statusColor, } from "../lib/format.js";
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
        .option("--no-gitignore", "Don't ignore paths from .gitignore")
        .option("--path-as-root", "Use the path argument as the archive root")
        .option("-m, --message <text>", "Message to attach to the deployment")
        .option("--build-command <cmd>", "Build command to run (e.g. 'npm run build')")
        .option("--start-command <cmd>", "Start command to run (e.g. 'node dist/index.js')")
        .option("--pre-deploy-command <cmd>", "Pre-deploy command (e.g. 'node dist/migrate.js')")
        .option("--port <number>", "Container port (default: 3000)")
        .option("--worker", "Worker mode — service has no HTTP port (no Caddy route, no port wait)")
        .action(async (pathArg, opts, cmd) => {
        const merged = cmd.optsWithGlobals();
        const serviceFlag = merged.service ?? opts.service;
        const projectFlag = merged.project;
        // Run init flow if cwd isn't linked yet
        await ensureLinked({ projectName: projectFlag });
        // Resolve target service: --service flag → linked → first-in-project → prompt-or-fail
        const ctx = await resolveContext({
            projectFlag,
            serviceFlag,
        });
        const projectId = ctx.projectId;
        const targetPath = pathArg ? path.resolve(pathArg) : process.cwd();
        const archiveRoot = opts.pathAsRoot ? targetPath : process.cwd();
        // `up` always uploads code. For redeploy of an existing
        // build without re-uploading, use `lizard redeploy`.
        const gitRemote = !pathArg ? getGitRemote() : null;
        if (gitRemote && !ctx.service) {
            await deployFromGitRemote({
                projectId,
                repoUrl: normalizeGitUrl(gitRemote),
                branch: getGitBranch(),
                serviceFlag,
                opts,
            });
            return;
        }
        // ── Local folder upload (or path-arg deploy) ────────────────────────
        await deployFromLocal({
            projectId,
            targetPath,
            archiveRoot,
            useGitignore: opts.gitignore !== false,
            serviceFlag,
            existingServiceId: ctx.service?.id,
            buildCommand: opts.buildCommand,
            startCommand: opts.startCommand,
            preDeployCommand: opts.preDeployCommand,
            port: opts.worker ? 0 : (opts.port ? parseInt(opts.port, 10) : undefined),
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
async function deployFromGitRemote(args) {
    const defaultName = args.serviceFlag || getDefaultAppName();
    info(`Creating service from ${chalk.cyan(args.repoUrl)} (${chalk.dim(args.branch)})...`);
    const nameInput = args.serviceFlag || (await prompt(`Service name [${defaultName}]: `));
    const appName = nameInput || defaultName;
    const spinner = ora("Creating service...").start();
    let newApp;
    try {
        newApp = await api.post(`/api/projects/${args.projectId}/apps`, {
            name: appName,
            repoUrl: args.repoUrl,
            branch: args.branch,
            message: args.opts.message,
        });
        spinner.succeed(`Service ${chalk.bold(newApp.name)} created`);
    }
    catch (err) {
        spinner.fail("Failed to create service");
        if (err?.message?.includes("private") || err?.message?.includes("Not Found")) {
            info(chalk.dim("\nRepo may be private. Run `lizard git connect` to grant access."));
        }
        throw err;
    }
    saveServiceToConfig(args.projectId, newApp.id, newApp.name);
    if (args.opts.detach) {
        isJSONMode()
            ? printJSON({ appId: newApp.id, version: 1, status: "deploying" })
            : success(`Deploy v1 started  ${chalk.dim(`lizard up status ${newApp.id}`)}`);
        return;
    }
    await streamBuildLogs(newApp.id, args.opts.ci);
}
async function deployFromLocal(args) {
    const defaultName = args.serviceFlag || getDefaultAppName(args.targetPath);
    info(`${args.existingServiceId ? "Uploading" : "Creating service from"} ${chalk.dim(args.targetPath)}`);
    let appName = args.serviceFlag || defaultName;
    if (!args.existingServiceId && !args.serviceFlag) {
        const nameInput = await prompt(`Service name [${defaultName}]: `);
        appName = nameInput || defaultName;
    }
    const files = getUploadFiles(args.targetPath, args.useGitignore);
    if (files.length === 0)
        throw new Error("No files to upload.");
    info(chalk.dim(`  ${files.length} files selected`));
    const detectedPort = args.port === undefined ? detectLocalPort(args.targetPath) : undefined;
    if (detectedPort)
        info(`Detected port ${chalk.bold(detectedPort)} from Dockerfile`);
    const tarball = await createTarball(files, args.archiveRoot);
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
            // New services with no detected port default to 3000
            if (resolvedPort === undefined)
                qs.set("port", "3000");
        }
        if (args.opts.message)
            qs.set("message", args.opts.message);
        if (args.existingServiceId)
            qs.set("appId", args.existingServiceId);
        if (args.buildCommand)
            qs.set("buildCommand", args.buildCommand);
        if (args.startCommand)
            qs.set("startCommand", args.startCommand);
        if (args.preDeployCommand)
            qs.set("preDeployCommand", args.preDeployCommand);
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
            const text = await res.text();
            throw new Error(text);
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
    await streamBuildLogs(newApp.id, args.opts.ci);
}
// ── helpers ──────────────────────────────────────────────────────────────────
function saveServiceToConfig(_projectId, serviceId, serviceName) {
    try {
        updateProjectLink({ serviceId, serviceName });
    }
    catch { }
}
function getGitRemote() {
    try {
        return (execSync("git config --get remote.origin.url", {
            encoding: "utf8",
            stdio: ["pipe", "pipe", "pipe"],
        }).trim() || null);
    }
    catch {
        return null;
    }
}
function normalizeGitUrl(url) {
    const ssh = url.match(/^git@([^:]+):(.+?)(?:\.git)?$/);
    if (ssh)
        return `https://${ssh[1]}/${ssh[2]}`;
    return url.replace(/\.git$/, "");
}
function getGitBranch() {
    try {
        return (execSync("git rev-parse --abbrev-ref HEAD", {
            encoding: "utf8",
            stdio: ["pipe", "pipe", "pipe"],
        }).trim() || "main");
    }
    catch {
        return "main";
    }
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
            const tracked = execSync("git ls-files", {
                cwd,
                encoding: "utf8",
                stdio: ["pipe", "pipe", "pipe"],
            })
                .trim()
                .split("\n")
                .filter(Boolean);
            const untracked = execSync("git ls-files --others --exclude-standard", {
                cwd,
                encoding: "utf8",
                stdio: ["pipe", "pipe", "pipe"],
            })
                .trim()
                .split("\n")
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
const EXCLUDE_EXT = new Set([".pyc", ".pyo", ".log", ".DS_Store"]);
function collectFilesManually(root, dir) {
    const results = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (EXCLUDE_DIRS.has(entry.name))
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
        const tar = spawn("tar", ["-czf", "-", "-T", "-"], { cwd });
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
        tar.stdin.write(files.join("\n"));
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
async function streamBuildLogs(appId, ciMode = false) {
    const spinner = ora("Waiting for build...").start();
    let buildId = null;
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
                        error(`Build failed: ${data}`);
                    else
                        success("Build complete");
                    return false;
                }
                try {
                    const parsed = JSON.parse(data);
                    if (parsed.line)
                        process.stdout.write(parsed.line + "\n");
                    else if (typeof parsed === "string")
                        process.stdout.write(parsed + "\n");
                }
                catch {
                    process.stdout.write(data + "\n");
                }
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
    if (app.status === "running")
        success(`Deployed! ${app.domain ? chalk.cyan(`https://${app.domain}`) : ""}`);
    else if (app.status === "failed")
        error("Deploy failed. Check logs with `lizard logs --build`");
    else if (app.status === "deploying")
        info(chalk.dim("Still deploying... check status with `lizard ps`"));
}
function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
//# sourceMappingURL=up.js.map