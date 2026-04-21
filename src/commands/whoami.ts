import chalk from "chalk";
import { Command } from "commander";
import { api } from "../lib/api.js";
import { isJSONMode, printJSON } from "../lib/format.js";

export function registerWhoami(program: Command) {
  program
    .command("whoami")
    .description("Show current user")
    .action(async () => {
      const user = await api.get<{
        id: string;
        username: string;
        avatarUrl?: string;
        hasGithubApp?: boolean;
      }>("/api/auth/me");

      if (isJSONMode()) {
        printJSON(user);
      } else {
        console.log(chalk.bold(user.username));
        if (user.hasGithubApp) {
          console.log(chalk.dim("GitHub App: connected"));
        }
      }
    });
}
