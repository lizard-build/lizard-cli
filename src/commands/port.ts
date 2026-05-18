import chalk from "chalk";
import { Command } from "commander";
import { api } from "../lib/api.js";
import { resolveProjectId } from "../lib/config.js";
import { getActiveService } from "../lib/resolve.js";
import { success, info, isJSONMode, printJSON } from "../lib/format.js";

/**
 * `lizard port [number]`
 *   bare     → show current container port
 *   <number> → update container port (takes effect on next deploy)
 */
export function registerPort(program: Command) {
  program
    .command("port")
    .argument("[port]", "Port number to set")
    .description("Show or change the container port for a service")
    .option("-s, --service <name>", "Service name or ID")
    .option("--project <id>", "Project name or ID")
    .action(async (portArg: string | undefined, opts) => {
      const projectId = await resolveProjectId(opts.project);
      const service = await getActiveService(opts.service, projectId);

      if (portArg === undefined) {
        const app = await api.get<{ containerPort?: number }>(`/api/apps/${service.id}`);
        const port = app.containerPort ?? 3000;
        if (isJSONMode()) {
          printJSON({ port });
        } else {
          info(`${chalk.bold(service.name)} container port: ${chalk.cyan(port)}`);
        }
        return;
      }

      const newPort = parseInt(portArg, 10);
      if (isNaN(newPort) || newPort < 1 || newPort > 65535) {
        throw new Error(`Invalid port: ${portArg}. Must be 1–65535.`);
      }

      await api.patch(`/api/apps/${service.id}`, { containerPort: newPort });

      if (isJSONMode()) {
        printJSON({ ok: true, port: newPort });
      } else {
        success(
          `${chalk.bold(service.name)} container port set to ${chalk.cyan(newPort)} — takes effect on next deploy`,
        );
      }
    });
}
