import chalk from "chalk";
import { Command } from "commander";
import { api } from "../lib/api.js";
import { getProjectLink } from "../lib/config.js";
import { isJSONMode, printJSON } from "../lib/format.js";

export function registerWhoami(program: Command) {
  program
    .command("whoami")
    .description("Show current user, active workspace, and linked project")
    .action(async () => {
      const user = await api.get<{
        id: string;
        username: string;
        avatarUrl?: string;
        hasGithubApp?: boolean;
        activeWorkspaceId?: string | null;
        activeWorkspaceName?: string | null;
        defaultWorkspaceId?: string | null;
        // Present only when the caller is a SCOPED API key. The account's email,
        // balance and plan are withheld in that case — they belong to the account,
        // not to the key holder, and a scoped key is made to be handed to someone
        // else or injected into a sandbox. --json prints whatever the server sends,
        // so this is also what stops `whoami --json` from leaking them.
        scoped?: boolean;
        scopes?: Array<{ type: "workspace" | "project"; id: string }>;
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

      if (isJSONMode()) {
        printJSON({ ...user, project });
        return;
      }

      console.log(chalk.bold(user.username));
      if (user.scoped) {
        const n = user.scopes?.length ?? 0;
        console.log(
          chalk.dim("Key: ") +
            `scoped to ${n} ${n === 1 ? "resource" : "resources"}` +
            chalk.dim(" (account billing and settings are not visible)"),
        );
        for (const sc of user.scopes ?? []) {
          console.log(chalk.dim(`  ${sc.type} ${sc.id}`));
        }
      }
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
