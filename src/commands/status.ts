import chalk from "chalk";
import { Command } from "commander";
import { api } from "../lib/api.js";
import { resolveProjectId, findProjectConfig } from "../lib/config.js";
import { isJSONMode, printJSON, statusColor, table } from "../lib/format.js";

export function registerStatus(program: Command) {
  program
    .command("status")
    .description("Show project status")
    .action(async () => {
      const projectId = resolveProjectId(program.opts().project);
      const config = findProjectConfig();

      const [project, services] = await Promise.all([
        api.get<{ id: string; name: string; slug: string }>(
          `/api/projects/${projectId}`,
        ),
        api.get<{ apps: any[]; addons: any[] }>(
          `/api/projects/${projectId}/services`,
        ),
      ]);

      if (isJSONMode()) {
        printJSON({ project, services, environment: config?.environment || "production" });
        return;
      }

      console.log(chalk.bold(project.name) + chalk.dim(` (${project.id})`));
      if (config?.environment) {
        console.log(chalk.dim(`Environment: ${config.environment}`));
      }
      console.log();

      const allServices = [
        ...(services.apps || []).map((a: any) => ({
          name: a.name,
          type: "app",
          status: a.status,
          url: a.domain ? `https://${a.domain}` : "",
        })),
        ...(services.addons || []).map((a: any) => ({
          name: a.name || a.addonType,
          type: a.addonType || "addon",
          status: a.status,
          url: a.hostname || "",
        })),
      ];

      if (allServices.length === 0) {
        console.log(chalk.dim("No services"));
        return;
      }

      table(
        ["Name", "Type", "Status", "URL"],
        allServices.map((s) => [
          s.name,
          s.type,
          statusColor(s.status),
          s.url || chalk.dim("—"),
        ]),
      );
    });
}
