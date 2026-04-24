import chalk from "chalk";
import ora from "ora";
import { execSync, spawn } from "child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { api, streamSSE, getBaseURL } from "../lib/api.js";
import { updateProjectLink } from "../lib/config.js";
import { ensureLinked } from "./init.js";
import { success, info, error, isJSONMode, printJSON, statusColor, } from "../lib/format.js";
export function registerDeploy(program) {
    const deploy = program
        .command("deploy")
        .description("Deploy the current project")
        .option("--detach", "Run in background without streaming logs")
        .option("--region <region>", "Region for deployment")
        .action(async (opts) => {
        // Run init flow if this directory isn't linked yet
        const link = await ensureLinked();
        const projectId = link.projectId;
        // ── Redeploy: use saved appId directly (fast path) ───────────────────
        if (link.appId) {
            const app = await api.get(`/api/apps/${link.appId}`).catch(() => null);
            if (app) {
                const version = (app.builds?.length ?? 0) + 1;
                info(`Deploying ${chalk.bold(app.name)} ${chalk.dim(`v${version}`)}...`);
                await api.post(`/api/apps/${app.id}/redeploy`);
                if (opts.detach) {
                    isJSONMode()
                        ? printJSON({ appId: app.id, version, status: "deploying" })
                        : success(`Deploy v${version} started  ${chalk.dim(`lizard deploy status ${app.id}`)}`);
                    return;
                }
                await streamBuildLogs(app.id);
                return;
            }
            // app was deleted — fall through to create a new one
        }
        // ── Redeploy: no saved appId — look up by project ────────────────────
        const services = await api.get(`/api/projects/${projectId}/services`);
        if (services.apps && services.apps.length > 0) {
            const app = services.apps[0];
            const version = (app.builds?.length ?? 0) + 1;
            info(`Deploying ${chalk.bold(app.name)} ${chalk.dim(`v${version}`)}...`);
            await api.post(`/api/apps/${app.id}/redeploy`);
            // Save for next time
            saveServiceToConfig(projectId, app.id, app.name);
            if (opts.detach) {
                isJSONMode()
                    ? printJSON({ appId: app.id, version, status: "deploying" })
                    : success(`Deploy v${version} started  ${chalk.dim(`lizard deploy status ${app.id}`)}`);
                return;
            }
            await streamBuildLogs(app.id);
            return;
        }
        // ── First deploy ──────────────────────────────────────────────────────
        const gitRemote = getGitRemote();
        if (gitRemote) {
            // GitHub deploy
            const repoUrl = normalizeGitUrl(gitRemote);
            const branch = getGitBranch();
            const defaultName = getDefaultAppName();
            info(`Creating app from ${chalk.cyan(repoUrl)} (${chalk.dim(branch)})...`);
            const nameInput = await prompt(`App name [${defaultName}]: `);
            const appName = nameInput || defaultName;
            const spinner = ora("Creating app...").start();
            let newApp;
            try {
                newApp = await api.post(`/api/projects/${projectId}/apps`, { name: appName, repoUrl, branch });
                spinner.succeed(`App ${chalk.bold(newApp.name)} created`);
            }
            catch (err) {
                spinner.fail("Failed to create app");
                if (err?.message?.includes("private") || err?.message?.includes("Not Found")) {
                    info(chalk.dim("\nRepo may be private. Run `lizard git connect` to grant access."));
                }
                throw err;
            }
            saveServiceToConfig(projectId, newApp.id, newApp.name);
            if (opts.detach) {
                isJSONMode()
                    ? printJSON({ appId: newApp.id, version: 1, status: "deploying" })
                    : success(`Deploy v1 started  ${chalk.dim(`lizard deploy status ${newApp.id}`)}`);
                return;
            }
            await streamBuildLogs(newApp.id);
        }
        else {
            // Local folder upload
            const defaultName = getDefaultAppName();
            info(`No git remote found — deploying local folder ${chalk.dim(process.cwd())}`);
            const nameInput = await prompt(`App name [${defaultName}]: `);
            const appName = nameInput || defaultName;
            const files = getUploadFiles();
            if (files.length === 0)
                throw new Error("No files to upload.");
            info(chalk.dim(`  ${files.length} files selected`));
            const tarball = await createTarball(files);
            info(chalk.dim(`  Tarball: ${(tarball.length / 1024 / 1024).toFixed(1)} MB`));
            const spinner = ora("Uploading...").start();
            let newApp;
            try {
                const url = `${getBaseURL()}/api/projects/${projectId}/apps/upload?name=${encodeURIComponent(appName)}&port=3000`;
                const res = await fetch(url, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/octet-stream",
                        "Authorization": `Bearer ${(await import("../lib/auth.js")).getToken()}`,
                    },
                    body: tarball.buffer,
                });
                if (!res.ok) {
                    const text = await res.text();
                    throw new Error(text);
                }
                newApp = await res.json();
                spinner.succeed(`App ${chalk.bold(newApp.name)} created`);
            }
            catch (err) {
                spinner.fail("Upload failed");
                throw err;
            }
            saveServiceToConfig(projectId, newApp.id, newApp.name);
            if (opts.detach) {
                isJSONMode()
                    ? printJSON({ appId: newApp.id, version: 1, status: "deploying" })
                    : success(`Deploy v1 started  ${chalk.dim(`lizard deploy status ${newApp.id}`)}`);
                return;
            }
            await streamBuildLogs(newApp.id);
        }
    });
    deploy
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
// ── helpers ──────────────────────────────────────────────────────────────────
function saveServiceToConfig(_projectId, appId, appName) {
    try {
        updateProjectLink({ appId, appName });
    }
    catch { }
}
function getGitRemote() {
    try {
        return execSync("git config --get remote.origin.url", {
            encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
        }).trim() || null;
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
        return execSync("git rev-parse --abbrev-ref HEAD", {
            encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
        }).trim() || "main";
    }
    catch {
        return "main";
    }
}
function getDefaultAppName() {
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"));
        if (pkg.name)
            return pkg.name.replace(/^@[^/]+\//, "");
    }
    catch { }
    return path.basename(process.cwd());
}
function getUploadFiles() {
    try {
        // Use git ls-files for tracked + untracked-but-not-ignored files
        const tracked = execSync("git ls-files", {
            encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
        }).trim().split("\n").filter(Boolean);
        const untracked = execSync("git ls-files --others --exclude-standard", {
            encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
        }).trim().split("\n").filter(Boolean);
        return [...new Set([...tracked, ...untracked])];
    }
    catch {
        // Not a git repo — manual exclusion
        return collectFilesManually(process.cwd(), process.cwd());
    }
}
const EXCLUDE_DIRS = new Set([
    "node_modules", ".git", "dist", ".next", "build", "__pycache__",
    ".venv", "venv", ".cache", "coverage", ".turbo", ".vercel",
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
function createTarball(files) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        // Write file list to stdin so tar handles paths with spaces/special chars
        const tar = spawn("tar", ["-czf", "-", "-T", "-"], { cwd: process.cwd() });
        tar.stdout.on("data", (c) => chunks.push(c));
        tar.stderr.on("data", () => { }); // suppress tar stderr
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
function prompt(question) {
    return new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question(question, (answer) => { rl.close(); resolve(answer.trim()); });
    });
}
async function streamBuildLogs(appId) {
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
        info(chalk.dim("No build found. Check `lizard deploy status <id>`."));
        return;
    }
    info(chalk.dim("Streaming build logs...\n"));
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
    const app = await api.get(`/api/apps/${appId}`);
    if (app.status === "running")
        success(`Deployed! ${app.domain ? chalk.cyan(`https://${app.domain}`) : ""}`);
    else if (app.status === "failed")
        error("Deploy failed. Check logs with `lizard logs --build`");
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
//# sourceMappingURL=deploy.js.map