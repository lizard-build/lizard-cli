import chalk from "chalk";
import { Command } from "commander";
import { api, withScope } from "../lib/api.js";
import { getActiveServiceWithKind, resolveProjectScope } from "../lib/resolve.js";
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
    .option("-p, --project <id>", "Project name, slug, or ID")
    .action(async (portArg: string | undefined, opts) => {
      const { projectId, scope } = await resolveProjectScope(opts.project);
      const service = await getActiveServiceWithKind(opts.service, projectId);
      if (service.kind === "addon") {
        throw new Error("Addons don't have a container port.");
      }

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

      // PATCH /api/apps/:id is 410-Gone server-side; writes go through
      // POST /api/projects/:id/config:apply.
      await api.post(
        withScope(`/api/projects/${projectId}/config:apply`, scope),
        { services: [{ id: service.id, name: service.name, containerPort: newPort }] },
      );

      if (isJSONMode()) {
        printJSON({ ok: true, port: newPort });
      } else {
        success(
          `${chalk.bold(service.name)} container port set to ${chalk.cyan(newPort)} — takes effect on next deploy`,
        );
      }
    });
}
