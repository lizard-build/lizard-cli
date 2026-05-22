import chalk from "chalk";
import { Command } from "commander";
import { api, withScope } from "../lib/api.js";
import { getProjectLink } from "../lib/config.js";
import { resolveProjectScope } from "../lib/resolve.js";
import { isJSONMode, printJSON, table, statusColor } from "../lib/format.js";

export function registerPs(program: Command) {
  program
    .command("ps")
    .description("List all services in the project")
    .option("-p, --project <id>", "Project name or ID")
    .action(async (opts) => {
      const { projectId, scope } = await resolveProjectScope(opts.project);
      const data = await api.get<{ apps: any[]; addons: any[] }>(
        withScope(`/api/projects/${projectId}/services`, scope),
      );

      if (isJSONMode()) {
        printJSON(data);
        return;
      }

      const apps = data.apps || [];
      const addons = data.addons || [];

      if (apps.length === 0 && addons.length === 0) {
        console.log("No services. Use `lizard add` or `lizard up`.");
        return;
      }

      const linkedId = getProjectLink()?.serviceId;

      if (apps.length > 0) {
        table(
          ["App", "Status", "URL", "Linked"],
          apps.map((a: any) => [
            a.name || a.id,
            statusColor(a.status),
            a.domain ? chalk.cyan(`https://${a.domain}`) : chalk.dim("—"),
            a.id === linkedId ? chalk.green("✓") : "",
          ]),
        );
      }

      if (addons.length > 0) {
        if (apps.length > 0) console.log();
        table(
          ["Addon", "Type", "Status", "Host"],
          addons.map((a: any) => [
            a.name || a.type,
            a.type,
            statusColor(a.status),
            a.hostname ? chalk.dim(a.hostname) : chalk.dim("—"),
          ]),
        );
      }
    });
}
