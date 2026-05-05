import chalk from "chalk";
import { Command } from "commander";
import { api } from "../lib/api.js";
import { resolveProjectId } from "../lib/config.js";
import { getActiveService } from "../lib/resolve.js";
import { success, info, isJSONMode, printJSON } from "../lib/format.js";

/**
 * `lizard port [number]`
 *   bare         → show current container port
 *   <number>     → update container port (takes effect on next deploy)
 *   0 / --worker → set worker mode (no port, no HTTP proxy)
 */
export function registerPort(program: Command) {
  program
    .command("port")
    .argument("[port]", "Port number to set (0 = worker mode)")
    .description("Show or change the container port for a service")
    .option("-s, --service <name>", "Service name or ID")
    .option("-p, --project <id>", "Project name or ID")
    .option("--worker", "Set worker mode (no HTTP port)")
    .action(async (portArg: string | undefined, opts) => {
      const projectId = resolveProjectId(opts.project);
      const service = await getActiveService(opts.service, projectId);

      if (portArg === undefined && !opts.worker) {
        const app = await api.get<{ containerPort?: number }>(`/api/apps/${service.id}`);
        const port = app.containerPort ?? 3000;
        if (isJSONMode()) {
          printJSON({ port });
        } else {
          info(`${chalk.bold(service.name)} container port: ${chalk.cyan(port === 0 ? "none (worker)" : port)}`);
        }
        return;
      }

      const newPort = opts.worker ? 0 : parseInt(portArg!, 10);
      if (!opts.worker && (isNaN(newPort) || newPort < 0 || newPort > 65535)) {
        throw new Error(`Invalid port: ${portArg}. Must be 0–65535.`);
      }

      await api.patch(`/api/apps/${service.id}`, { containerPort: newPort });

      if (isJSONMode()) {
        printJSON({ ok: true, port: newPort });
      } else {
        success(
          newPort === 0
            ? `${chalk.bold(service.name)} set to worker mode (no HTTP port)`
            : `${chalk.bold(service.name)} container port set to ${chalk.cyan(newPort)} — takes effect on next deploy`,
        );
      }
    });
}
