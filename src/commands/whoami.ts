import chalk from "chalk";
import { Command } from "commander";
import { api } from "../lib/api.js";
import { getProjectLink } from "../lib/config.js";
import { isJSONMode, printJSON } from "../lib/format.js";

export function registerWhoami(program: Command) {
  program
    .command("whoami")
    .description("Show current user and linked project")
    .action(async () => {
      const user = await api.get<{
        id: string;
        username: string;
        avatarUrl?: string;
        hasGithubApp?: boolean;
      }>("/api/auth/me");

      const link = getProjectLink();
      const project = link
        ? { id: link.projectId, name: link.projectName }
        : null;

      if (isJSONMode()) {
        printJSON({ ...user, project });
        return;
      }

      console.log(chalk.bold(user.username));
      if (user.hasGithubApp) {
        console.log(chalk.dim("GitHub App: connected"));
      }

      if (project) {
        const label = project.name || project.id;
        console.log(chalk.dim("Project: ") + label + chalk.dim(" (linked here)"));
      } else {
        console.log(
          chalk.dim("Project: none — run `lizard init` in a project directory"),
        );
      }
    });
}
