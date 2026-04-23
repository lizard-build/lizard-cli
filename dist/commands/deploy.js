import chalk from "chalk";
import ora from "ora";
import { execSync } from "child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { api, streamSSE } from "../lib/api.js";
import { resolveProjectId } from "../lib/config.js";
import { success, info, error, isJSONMode, printJSON, statusColor, } from "../lib/format.js";
export function registerDeploy(program) {
    const deploy = program
        .command("deploy")
        .description("Deploy the current project")
        .option("--detach", "Run in background without streaming logs")
        .option("--region <region>", "Region for deployment")
        .action(async (opts) => {
        const projectId = resolveProjectId(program.opts().project, { localOnly: true });
        const services = await api.get(`/api/projects/${projectId}/services`);
        if (services.apps && services.apps.length > 0) {
            // Redeploy existing app
            const app = services.apps[0];
            info(`Redeploying ${chalk.bold(app.name)}...`);
            await api.post(`/api/apps/${app.id}/redeploy`);
            if (opts.detach) {
                if (isJSONMode()) {
                    printJSON({ appId: app.id, status: "deploying" });
                }
                else {
                    success(`Redeploy started for ${app.name}`);
                    info(chalk.dim(`  Check status: lizard deploy status ${app.id}`));
                }
                return;
            }
            await streamBuildLogs(app.id);
            return;
        }
        // First deploy — detect git remote and create app
        const rawRemote = getGitRemote();
        if (!rawRemote) {
            throw new Error("No git remote found.\n" +
                "  Run: git remote add origin https://github.com/you/your-repo\n" +
                "  Or create an app from the dashboard.");
        }
        const repoUrl = normalizeGitUrl(rawRemote);
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
                info(chalk.dim("\nRepo may be private. Run `lizard git connect` to grant access to private repos."));
            }
            throw err;
        }
        if (opts.detach) {
            if (isJSONMode()) {
                printJSON({ appId: newApp.id, status: "deploying" });
            }
            else {
                success(`Deploy started for ${newApp.name}`);
                info(chalk.dim(`  Check status: lizard deploy status ${newApp.id}`));
            }
            return;
        }
        await streamBuildLogs(newApp.id);
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
        if (app.builds?.length) {
            const latest = app.builds[0];
            console.log(`  Latest build: ${statusColor(latest.status)}`);
        }
    });
}
// ── helpers ──────────────────────────────────────────────────────────────────
function getGitRemote() {
    try {
        return execSync("git config --get remote.origin.url", {
            encoding: "utf8",
            stdio: ["pipe", "pipe", "pipe"],
        }).trim() || null;
    }
    catch {
        return null;
    }
}
function normalizeGitUrl(url) {
    // git@github.com:user/repo.git → https://github.com/user/repo
    const ssh = url.match(/^git@([^:]+):(.+?)(?:\.git)?$/);
    if (ssh)
        return `https://${ssh[1]}/${ssh[2]}`;
    return url.replace(/\.git$/, "");
}
function getGitBranch() {
    try {
        return execSync("git rev-parse --abbrev-ref HEAD", {
            encoding: "utf8",
            stdio: ["pipe", "pipe", "pipe"],
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
function prompt(question) {
    return new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question(question, (answer) => {
            rl.close();
            resolve(answer.trim());
        });
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
        info(chalk.dim("No build found. Check `lizard deploy status <id>` for status."));
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
    if (app.status === "running") {
        success(`Deployed! ${app.domain ? chalk.cyan(`https://${app.domain}`) : ""}`);
    }
    else if (app.status === "failed") {
        error("Deploy failed. Check logs with `lizard logs --build`");
    }
}
function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
//# sourceMappingURL=deploy.js.map