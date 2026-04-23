import chalk from "chalk";
import ora from "ora";
import * as readline from "node:readline";
import { Command } from "commander";
import { api, getBaseURL } from "../lib/api.js";
import { openURL } from "../lib/auth.js";
import { resolveProjectId } from "../lib/config.js";
import { success, error, info, isJSONMode, printJSON } from "../lib/format.js";

interface GitHubStatus {
  installed: boolean;
  installationId: number | null;
}

export function registerGit(program: Command) {
  const git = program
    .command("git")
    .description("Git and GitHub integration");

  // lizard git connect — install GitHub App for private repo access
  git
    .command("connect")
    .description("Connect GitHub App to access private repositories")
    .action(async () => {
      // Check current status
      const status = await api.get<GitHubStatus>("/api/github/status");

      if (status.installed) {
        success("GitHub App is already connected.");
        info(chalk.dim("  Use `lizard git status` to see connected repositories."));
        return;
      }

      const installUrl = `${getBaseURL()}/api/auth/github/install`;
      const opened = await openURL(installUrl);

      if (opened) {
        info("Opening GitHub to install the Lizard GitHub App...");
      } else {
        info(`Open this URL to connect GitHub:\n  ${chalk.cyan(installUrl)}`);
      }

      // Wait for user to complete installation in browser
      await pressEnter(chalk.dim("\nPress Enter after completing GitHub installation..."));

      // Verify
      const spinner = ora("Verifying GitHub connection...").start();
      const newStatus = await api.get<GitHubStatus>("/api/github/status");
      spinner.stop();

      if (newStatus.installed) {
        success("GitHub connected! You can now deploy private repositories.");
        info(chalk.dim("  Run `lizard deploy` to deploy your project."));
      } else {
        error("GitHub App not detected. Please try again or connect via the dashboard.");
        process.exit(1);
      }
    });

  // lizard git disconnect
  git
    .command("disconnect")
    .description("Disconnect Git auto-deploy")
    .action(async () => {
      info(chalk.dim("Git disconnect via CLI will be available in a future update."));
    });

  // lizard git status
  git
    .command("status")
    .description("Show GitHub connection and repository status")
    .action(async () => {
      const projectId = resolveProjectId(program.opts().project);

      const [githubStatus, services] = await Promise.all([
        api.get<GitHubStatus>("/api/github/status"),
        api.get<{ apps: any[] }>(`/api/projects/${projectId}/services`),
      ]);

      const appsWithRepo = (services.apps || []).filter((a: any) => a.repo || a.repoUrl);

      if (isJSONMode()) {
        printJSON({
          github: {
            installed: githubStatus.installed,
            installationId: githubStatus.installationId,
          },
          apps: appsWithRepo.map((a: any) => ({
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
      } else {
        info(`GitHub App: ${chalk.yellow("not connected")}  ${chalk.dim("→ run `lizard git connect`")}`);
      }

      // Connected repos
      if (appsWithRepo.length === 0) {
        info(chalk.dim("\nNo repositories connected to this project."));
        return;
      }

      info("");
      for (const app of appsWithRepo) {
        info(
          `${chalk.bold(app.name)}: ${chalk.cyan(app.repo || app.repoUrl)} ${chalk.dim(`(${app.branch || "main"})`)}`,
        );
      }
    });
}

function pressEnter(question: string): Promise<void> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, () => {
      rl.close();
      resolve();
    });
  });
}
