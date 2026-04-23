import chalk from "chalk";
import { api } from "../lib/api.js";
import { findProjectConfig, loadGlobalSettings } from "../lib/config.js";
import { isJSONMode, printJSON } from "../lib/format.js";
export function registerWhoami(program) {
    program
        .command("whoami")
        .description("Show current user and active project")
        .action(async () => {
        const user = await api.get("/api/auth/me");
        const local = findProjectConfig();
        const global = loadGlobalSettings();
        const activeProject = local?.projectId
            ? {
                source: "link",
                id: local.projectId,
                name: local.projectName,
            }
            : global.defaultProject
                ? {
                    source: "default",
                    id: global.defaultProject,
                    name: global.defaultProjectName,
                }
                : null;
        if (isJSONMode()) {
            printJSON({ ...user, project: activeProject });
            return;
        }
        console.log(chalk.bold(user.username));
        if (user.hasGithubApp) {
            console.log(chalk.dim("GitHub App: connected"));
        }
        if (activeProject) {
            const label = activeProject.name || activeProject.id;
            const tag = activeProject.source === "link" ? "linked here" : "default";
            console.log(chalk.dim(`Project: `) + label + chalk.dim(` (${tag})`));
        }
        else {
            console.log(chalk.dim("Project: none — run `lizard link` or `lizard project use <name>`"));
        }
    });
}
//# sourceMappingURL=whoami.js.map