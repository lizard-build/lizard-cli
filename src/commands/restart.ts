import chalk from "chalk";
import ora from "ora";
import { Command } from "commander";
import { api } from "../lib/api.js";
import { success, isJSONMode, printJSON } from "../lib/format.js";

export function registerRestart(program: Command) {
  program
    .command("restart")
    .argument("<id>", "Service ID to restart")
    .description("Restart a service")
    .action(async (id: string) => {
      const spinner = ora("Restarting...").start();

      await api.post(`/api/apps/${id}/restart`);

      spinner.stop();
      if (isJSONMode()) {
        printJSON({ id, status: "restarting" });
      } else {
        success(`Service ${id} restarting`);
      }
    });
}
