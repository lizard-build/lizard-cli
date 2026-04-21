import chalk from "chalk";
import { Command } from "commander";
import { api } from "../lib/api.js";
import { resolveProjectId } from "../lib/config.js";
import { success, info, isJSONMode, printJSON } from "../lib/format.js";

export function registerGit(program: Command) {
  const git = program
    .command("git")
    .description("Git integration");

  git
    .command("connect")
    .argument("<repo>", "GitHub repository (user/repo)")
    .description("Connect Git repository for auto-deploy")
    .option("--branch <name>", "Branch for auto-deploy", "main")
    .action(async (repo: string, opts) => {
      const projectId = resolveProjectId(program.opts().project);

      // This requires a server endpoint for programmatic webhook setup
      // For now, guide the user to use the dashboard
      if (isJSONMode()) {
        printJSON({
          error: "not_implemented",
          message: "Git connect via CLI requires server endpoint. Use the dashboard.",
        });
      } else {
        info(`To connect ${chalk.cyan(repo)} for auto-deploy:`);
        info(`  1. Open your project on lizard.build`);
        info(`  2. Go to Settings → Git Integration`);
        info(`  3. Connect ${repo} (branch: ${opts.branch})`);
        info("");
        info(chalk.dim("CLI git connect will be available in a future update."));
      }
    });

  git
    .command("disconnect")
    .description("Disconnect Git auto-deploy")
    .action(async () => {
      info(chalk.dim("Git disconnect via CLI will be available in a future update."));
    });

  git
    .command("status")
    .description("Show Git integration status")
    .action(async () => {
      const projectId = resolveProjectId(program.opts().project);

      // Get apps to check for repo info
      const services = await api.get<{ apps: any[] }>(
        `/api/projects/${projectId}/services`,
      );

      const appsWithRepo = (services.apps || []).filter((a: any) => a.repo);

      if (isJSONMode()) {
        printJSON({
          connected: appsWithRepo.length > 0,
          apps: appsWithRepo.map((a: any) => ({
            name: a.name,
            repo: a.repo,
            branch: a.branch,
          })),
        });
        return;
      }

      if (appsWithRepo.length === 0) {
        console.log("No Git repositories connected.");
        return;
      }

      for (const app of appsWithRepo) {
        console.log(
          `${chalk.bold(app.name)}: ${chalk.cyan(app.repo)} (${app.branch || "main"})`,
        );
      }
    });
}
