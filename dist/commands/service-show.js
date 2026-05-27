import { api, withScope } from "../lib/api.js";
import { resolveProjectScope, resolveService } from "../lib/resolve.js";
import { printJSON } from "../lib/format.js";
/**
 * `lizard service show` — print the current service configuration as JSON.
 *
 * Works for both apps and addons. Without `-s` shows the whole project
 * (`{ apps, addons }`). With `-s <name>` shows just that service.
 *
 * Useful for diff-ing against a `lizard.config.json`, seeding a new file,
 * or feeding into `lizard service set` to roll back.
 */
export function registerServiceShow(svc) {
    svc
        .command("show")
        .description("Show the current service configuration as JSON")
        .argument("[service]", "Service name or ID (omit for whole project)")
        .option("-s, --service <name>", "Limit output to one service")
        .option("-p, --project <id>", "Project name, slug, or ID")
        .action(async (serviceArg, opts) => {
        const { projectId, scope } = await resolveProjectScope(opts.project);
        const ref = serviceArg || opts.service;
        if (ref) {
            const svcInfo = await resolveService(projectId, ref);
            if (svcInfo.kind === "app") {
                const detail = await api.get(withScope(`/api/apps/${svcInfo.id}`, scope));
                printJSON(detail);
                return;
            }
            // Addons: pluck from the project /services endpoint, which already
            // returns rich addon objects (connection, config, volume, region).
            // There is no per-addon GET route on the backend.
            const data = await api.get(withScope(`/api/projects/${projectId}/services`, scope));
            const addon = (data.addons || []).find((a) => a.id === svcInfo.id);
            if (!addon)
                throw new Error(`Addon ${svcInfo.name} not found`);
            printJSON(addon);
            return;
        }
        const data = await api.get(withScope(`/api/projects/${projectId}/services`, scope));
        printJSON(data);
    });
}
//# sourceMappingURL=service-show.js.map