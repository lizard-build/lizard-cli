import chalk from "chalk";
import { api } from "../lib/api.js";
import { getProjectLink } from "../lib/config.js";
import { isJSONMode, printJSON } from "../lib/format.js";
export function registerWhoami(program) {
    program
        .command("whoami")
        .description("Show current user, active workspace, and linked project")
        .action(async () => {
        const user = await api.get("/api/auth/me");
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
        }
        else {
            console.log(chalk.dim("Project: none — run `lizard init` in a project directory"));
        }
    });
}
//# sourceMappingURL=whoami.js.map