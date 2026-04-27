import { api } from "../lib/api.js";
import { resolveProjectId } from "../lib/config.js";
import { resolveService } from "../lib/resolve.js";
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
export function registerServiceShow(svc) {
    svc
        .command("show")
        .description("Show the current service configuration as JSON")
        .option("-s, --service <name>", "Limit output to one service")
        .option("-p, --project <id>", "Project name or ID")
        .action(async (opts) => {
        const projectId = resolveProjectId(opts.project);
        if (opts.service) {
            const svcInfo = await resolveService(projectId, opts.service);
            const detail = await api
                .get(`/api/apps/${svcInfo.id}/config`)
                .catch((err) => {
                if (err?.status === 404) {
                    throw new Error("Service config endpoint not yet implemented. The API needs " +
                        "`GET /api/apps/{id}/config` returning { source, build, deploy, variables }.");
                }
                throw err;
            });
            printJSON(detail);
            return;
        }
        const config = await api
            .get(`/api/projects/${projectId}/config`)
            .catch((err) => {
            if (err?.status === 404) {
                throw new Error("Project config endpoint not yet implemented. The API needs " +
                    "`GET /api/projects/{id}/config` returning { services: { <id>: {...} } }.");
            }
            throw err;
        });
        printJSON(config);
    });
}
//# sourceMappingURL=service-show.js.map