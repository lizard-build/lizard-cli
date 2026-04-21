import chalk from "chalk";
import { api } from "../lib/api.js";
import { isJSONMode, printJSON } from "../lib/format.js";
export function registerWhoami(program) {
    program
        .command("whoami")
        .description("Show current user")
        .action(async () => {
        const user = await api.get("/api/auth/me");
        if (isJSONMode()) {
            printJSON(user);
        }
        else {
            console.log(chalk.bold(user.username));
            if (user.hasGithubApp) {
                console.log(chalk.dim("GitHub App: connected"));
            }
        }
    });
}
//# sourceMappingURL=whoami.js.map