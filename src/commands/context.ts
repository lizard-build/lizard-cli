import chalk from "chalk";
import { Command } from "commander";
import { api } from "../lib/api.js";
import { resolveProjectId, findProjectConfig } from "../lib/config.js";
import { isJSONMode, printJSON, statusColor, table } from "../lib/format.js";

export function registerContext(program: Command) {
  program
    .command("context")
    .description("Show full project context (optimized for AI agents)")
    .action(async () => {
      const projectId = resolveProjectId(program.opts().project);
      const config = findProjectConfig();

      const [project, services, secrets] = await Promise.all([
        api.get<{ id: string; name: string; slug: string }>(
          `/api/projects/${projectId}`,
        ),
        api.get<{ apps: any[]; addons: any[] }>(
          `/api/projects/${projectId}/services`,
        ),
        api.get<Array<{ key: string; value: string }>>(
          `/api/projects/${projectId}/secrets`,
        ).catch(() => []),
      ]);

      const context = {
        project: {
          id: project.id,
          name: project.name,
          slug: project.slug,
        },
        environment: config?.environment || "production",
        apps: (services.apps || []).map((a: any) => ({
          id: a.id,
          name: a.name,
          status: a.status,
          domain: a.domain,
          repo: a.repo,
          branch: a.branch,
          cpuLimit: a.cpuLimit,
          memoryLimit: a.memoryLimit,
        })),
        addons: (services.addons || []).map((a: any) => ({
          id: a.id,
          name: a.name,
          type: a.addonType,
          status: a.status,
          hostname: a.hostname,
        })),
        secrets: secrets.map((s) => s.key), // names only, not values
      };

      // Always JSON for pipe, since this is designed for AI agents
      if (isJSONMode() || !process.stdout.isTTY) {
        printJSON(context);
        return;
      }

      // Human-readable
      console.log(chalk.bold(context.project.name) + chalk.dim(` (${context.project.id})`));
      console.log(chalk.dim(`Environment: ${context.environment}`));
      console.log();

      if (context.apps.length > 0) {
        console.log(chalk.bold("Apps:"));
        table(
          ["Name", "Status", "Domain"],
          context.apps.map((a) => [
            a.name,
            statusColor(a.status),
            a.domain ? `https://${a.domain}` : "—",
          ]),
        );
        console.log();
      }

      if (context.addons.length > 0) {
        console.log(chalk.bold("Addons:"));
        table(
          ["Name", "Type", "Status", "Host"],
          context.addons.map((a) => [a.name, a.type, statusColor(a.status), a.hostname || "—"]),
        );
        console.log();
      }

      if (context.secrets.length > 0) {
        console.log(
          chalk.bold("Secrets:") + " " + context.secrets.join(", "),
        );
      }
    });
}
