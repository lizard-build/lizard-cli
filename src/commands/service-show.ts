import { Command } from "commander";
import { api, withScope } from "../lib/api.js";
import { resolveProjectScope, resolveService } from "../lib/resolve.js";
import { printJSON } from "../lib/format.js";

/**
 * `lizard service show` — print the current service configuration as JSON.
 *
 * Useful for diff-ing against a `lizard.config.json`, seeding a new file,
 * or feeding into `lizard service set` to roll back.
 *
 * Without `-s` shows the whole project (all services keyed by ID).
 * With `-s <name>` shows just that service.
 */
export function registerServiceShow(svc: Command) {
  svc
    .command("show")
    .description("Show the current service configuration as JSON")
    .argument("[service]", "Service name or ID (omit for whole project)")
    .option("-s, --service <name>", "Limit output to one service")
    .option("-p, --project <id>", "Project name, slug, or ID")
    .action(async (serviceArg: string | undefined, opts) => {
      const { projectId, scope } = await resolveProjectScope(opts.project);

      const ref = serviceArg || opts.service;
      if (ref) {
        const svcInfo = await resolveService(projectId, ref);
        if (svcInfo.kind === "addon") {
          throw new Error(
            `\`service show\` is for apps. For addon details, use \`lizard service status ${svcInfo.name}\`.`,
          );
        }
        const detail = await api
          .get<unknown>(withScope(`/api/apps/${svcInfo.id}/config`, scope))
          .catch((err: any) => {
            if (err?.status === 404) {
              throw new Error(
                "Service config endpoint not yet implemented. The API needs " +
                  "`GET /api/apps/{id}/config` returning { source, build, deploy, variables }.",
              );
            }
            throw err;
          });
        printJSON(detail);
        return;
      }

      const config = await api
        .get<unknown>(withScope(`/api/projects/${projectId}/config`, scope))
        .catch((err: any) => {
          if (err?.status === 404) {
            throw new Error(
              "Project config endpoint not yet implemented. The API needs " +
                "`GET /api/projects/{id}/config` returning { services: { <id>: {...} } }.",
            );
          }
          throw err;
        });
      printJSON(config);
    });
}
