import chalk from "chalk";
import ora from "ora";
import * as readline from "node:readline";
import { api, getBaseURL, streamSSE, withScope } from "../lib/api.js";
import { openURL } from "../lib/auth.js";
import { resolveProjectScope, resolveService } from "../lib/resolve.js";
import { success, error, info, fail, isJSONMode, printJSON, isTTY, link } from "../lib/format.js";
export function registerGit(program) {
    const git = program
        .command("git")
        .description("Git and GitHub integration");
    // lizard git connect — install GitHub App for private repo access
    git
        .command("connect")
        .description("Connect GitHub App to access private repositories")
        .action(async () => {
        // Check current status
        const status = await api.get("/api/github/status");
        if (status.installed) {
            if (isJSONMode()) {
                printJSON({
                    installed: true,
                    installationId: status.installationId,
                    alreadyConnected: true,
                });
                return;
            }
            success("GitHub App is already connected.");
            info(chalk.dim("  Use `lizard git status` to see connected repositories."));
            return;
        }
        const installUrl = `${getBaseURL()}/api/auth/github/install`;
        // Non-interactive callers (--json, piped) can't press Enter; return
        // the install URL so they can drive the flow themselves and re-run.
        if (isJSONMode() || !isTTY()) {
            if (isJSONMode()) {
                printJSON({ installed: false, installUrl });
                return;
            }
            info(`Open this URL to connect GitHub:\n  ${chalk.cyan(installUrl)}`);
            return;
        }
        const opened = await openURL(installUrl);
        if (opened) {
            info("Opening GitHub to install the Lizard GitHub App...");
        }
        else {
            info(`Open this URL to connect GitHub:\n  ${chalk.cyan(installUrl)}`);
        }
        // Wait for user to complete installation in browser
        await pressEnter(chalk.dim("\nPress Enter after completing GitHub installation..."));
        // Verify
        const spinner = ora("Verifying GitHub connection...").start();
        const newStatus = await api.get("/api/github/status");
        spinner.stop();
        if (newStatus.installed) {
            success("GitHub connected! You can now deploy private repositories.");
            info(chalk.dim("  Run `lizard deploy` to deploy your project."));
        }
        else {
            fail("GitHub App not detected. Please try again or connect via the dashboard.");
        }
    });
    // lizard git checkout <service> <branch> — switch branch and redeploy
    git
        .command("checkout")
        .description("Switch a service to a different branch and redeploy")
        .argument("<service>", "Service name (as shown in the project)")
        .argument("<branch>", "Branch name to switch to")
        .option("--detach", "Start redeploy and exit without streaming logs")
        .option("-p, --project <id>", "Project name, slug, or ID")
        .action(async (serviceArg, branch, opts) => {
        const { projectId, scope } = await resolveProjectScope(opts.project);
        // Resolve service by name
        const svc = await resolveService(projectId, serviceArg);
        if (svc.kind !== "app")
            throw new Error(`"${serviceArg}" is not an app`);
        const serviceId = svc.id;
        const serviceName = svc.name ?? serviceArg;
        // Patch the branch
        const spinner = ora(`Switching ${chalk.bold(serviceName)} to branch ${chalk.cyan(branch)}...`).start();
        await api.post(withScope(`/api/projects/${projectId}/config:apply`, scope), {
            services: [{ name: serviceName, branch }],
        });
        spinner.succeed(`Branch set to ${chalk.cyan(branch)}`);
        // Trigger redeploy — the endpoint returns the freshly created Build
        // record; using its id avoids racing against a previous build.
        const deploySpinner = ora("Starting redeploy...").start();
        const build = await api.post(withScope(`/api/apps/${serviceId}/redeploy`, scope), undefined, { "X-Deploy-Source": "cli" });
        deploySpinner.stop();
        if (opts.detach || isJSONMode()) {
            if (isJSONMode())
                printJSON({ id: serviceId, buildId: build?.id, branch, status: "deploying" });
            else
                success(`Redeploy started on branch ${chalk.cyan(branch)}`);
            return;
        }
        info(`Redeploying ${chalk.bold(serviceName)} on ${chalk.cyan(branch)}...`);
        let buildId = build?.id ?? null;
        // Fallback for older servers that respond without a Build record.
        for (let i = 0; !buildId && i < 30; i++) {
            await new Promise((r) => setTimeout(r, 2000));
            try {
                const app = await api.get(`/api/apps/${serviceId}`);
                const latest = app.builds?.[0];
                if (latest && ["building", "deploying", "running", "failed"].includes(latest.status)) {
                    buildId = latest.id;
                    break;
                }
            }
            catch { }
        }
        if (buildId) {
            await streamSSE(`/api/builds/${buildId}/logs`, (event, data) => {
                if (event === "done" || event === "error") {
                    if (event === "error")
                        error(`Build failed: ${data}`);
                    return false;
                }
                try {
                    const parsed = JSON.parse(data);
                    process.stdout.write((typeof parsed === "string" ? parsed : (parsed.line ?? data)) + "\n");
                }
                catch {
                    process.stdout.write(data + "\n");
                }
                return true;
            });
        }
        const app = await api.get(`/api/apps/${serviceId}`);
        if (app.status === "running") {
            success(`Deployed! ${app.domain ? chalk.cyan(`https://${app.domain}`) : ""}`);
        }
        else {
            error("Deploy failed");
        }
    });
    // lizard git status
    git
        .command("status")
        .description("Show GitHub connection and repository status")
        .option("-p, --project <id>", "Project name, slug, or ID")
        .action(async (opts) => {
        const { projectId, scope } = await resolveProjectScope(opts.project);
        const [githubStatus, services] = await Promise.all([
            api.get("/api/github/status"),
            api.get(withScope(`/api/projects/${projectId}/services`, scope)),
        ]);
        const appsWithRepo = (services.apps || []).filter((a) => a.repo || a.repoUrl);
        if (isJSONMode()) {
            printJSON({
                github: {
                    installed: githubStatus.installed,
                    installationId: githubStatus.installationId,
                    installations: githubStatus.installations ?? [],
                    manageUrl: githubStatus.manageUrl,
                },
                apps: appsWithRepo.map((a) => ({
                    name: a.name,
                    repo: a.repo || a.repoUrl,
                    branch: a.branch,
                })),
            });
            return;
        }
        // GitHub App status
        if (githubStatus.installed) {
            info(`GitHub App: ${chalk.green("connected")}`);
            const installs = githubStatus.installations ?? [];
            for (const inst of installs) {
                const typeLabel = inst.account.type === "Organization" ? "org" : "user";
                const repoLabel = inst.repoCount !== null
                    ? chalk.dim(`${inst.repoCount} repos${inst.privateCount ? `, ${inst.privateCount} private` : ""}`)
                    : "";
                info(`  ${chalk.bold(inst.account.login)} ${chalk.dim(`(${typeLabel}, installation #${inst.id})`)}  ${repoLabel}`);
            }
            const manageUrl = githubStatus.manageUrl ?? `https://github.com/apps/lizard-app/installations/select_target`;
            info(chalk.dim(`  Manage: ${link(manageUrl)}`));
        }
        else {
            info(`GitHub App: ${chalk.yellow("not connected")}  ${chalk.dim("→ run `lizard git connect`")}`);
            if (githubStatus.error) {
                info(chalk.dim(`  (${githubStatus.error})`));
            }
        }
        // Connected repos
        if (appsWithRepo.length === 0) {
            info(chalk.dim("\nNo repositories connected to this project."));
            return;
        }
        info("");
        for (const app of appsWithRepo) {
            info(`${chalk.bold(app.name)}: ${chalk.cyan(app.repo || app.repoUrl)} ${chalk.dim(`(${app.branch || "main"})`)}`);
        }
    });
}
function pressEnter(question) {
    return new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question(question, () => {
            rl.close();
            resolve();
        });
    });
}
//# sourceMappingURL=git.js.map