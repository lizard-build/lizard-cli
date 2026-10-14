import chalk from "chalk";
import { Command } from "commander";
import { api } from "../lib/api.js";
import { getProjectLink } from "../lib/config.js";
import { isJSONMode, printJSON } from "../lib/format.js";
import { describeScope, type Me } from "../lib/signin.js";

export function registerWhoami(program: Command) {
  program
    .command("whoami")
    .description("Show current user, active workspace, and linked project")
    .action(async () => {
      const user = await api.get<Me & {
        avatarUrl?: string;
        hasGithubApp?: boolean;
        activeWorkspaceId?: string | null;
        activeWorkspaceName?: string | null;
        defaultWorkspaceId?: string | null;
      }>("/api/auth/me");

      const link = getProjectLink();
      const project = link
        ? {
            id: link.projectId,
            name: link.projectName,
            workspaceId: link.workspaceId ?? null,
            workspaceName: link.workspaceName ?? null,
          }
        : null;

      // A scoped key is handed to people who are not the account's members: it shows the
      // projects and workspaces it reaches, never whose account it is. The platform no
      // longer sends the owner for one; dropping it here covers an older platform too.
      if (user.scoped) {
        const scopes = user.scopes ?? [];
        if (isJSONMode()) {
          printJSON({ scoped: true, scopes, project });
          return;
        }
        console.log(chalk.bold("Scoped API key") + chalk.dim(" (account details are not visible)"));
        for (const sc of scopes) console.log(chalk.dim("  ") + describeScope(sc));
        if (project) {
          const wsTag = project.workspaceName ? chalk.dim(` (${project.workspaceName})`) : "";
          console.log(chalk.dim("Project: ") + (project.name || project.id) + wsTag + chalk.dim(" (linked here)"));
        }
        return;
      }

      if (isJSONMode()) {
        printJSON({ ...user, project });
        return;
      }

      console.log(chalk.bold(user.username));
      if (user.hasGithubApp) {
        console.log(chalk.dim("GitHub App: connected"));
      }
      if (user.activeWorkspaceName) {
        console.log(chalk.dim("Workspace: ") + user.activeWorkspaceName);
      }

      if (project) {
        const label = project.name || project.id;
        const wsTag = project.workspaceName ? chalk.dim(` (${project.workspaceName})`) : "";
        console.log(chalk.dim("Project: ") + label + wsTag + chalk.dim(" (linked here)"));
      } else {
        console.log(
          chalk.dim("Project: none — run `lizard init` in a project directory"),
        );
      }
    });
}
