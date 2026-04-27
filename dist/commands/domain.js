import chalk from "chalk";
import { api } from "../lib/api.js";
import { resolveProjectId } from "../lib/config.js";
import { getActiveService } from "../lib/resolve.js";
import { success, isJSONMode, printJSON, table } from "../lib/format.js";
/**
 * `lizard domain` — Railway-style domain management.
 *   bare         → list domains for linked/--service
 *   <hostname>   → add a custom domain
 *   delete <h>   → remove a domain
 *   generate     → create a *.lizard.app subdomain
 */
export function registerDomain(program) {
    const dom = program
        .command("domain")
        .alias("domains")
        .argument("[hostname]", "Custom domain to add (e.g. app.example.com)")
        .description("Manage service domains")
        .option("-s, --service <name>", "Service name or ID")
        .option("-p, --project <id>", "Project name or ID")
        .option("-e, --environment <name>", "Environment name or ID")
        .option("--port <n>", "Port to expose", parseIntOption)
        .action(async (hostname, opts, _cmd) => {
        const projectId = resolveProjectId(opts.project);
        const service = await getActiveService(opts.service, projectId);
        if (!hostname) {
            // List
            const domains = await api
                .get(`/api/apps/${service.id}/domains`)
                .catch(() => []);
            if (isJSONMode()) {
                printJSON(domains);
                return;
            }
            if (domains.length === 0) {
                console.log("No domains. Add one with `lizard domain <hostname>`.");
                return;
            }
            table(["Domain", "Type", "Port"], domains.map((d) => [
                chalk.cyan(`https://${d.domain}`),
                d.type,
                String(d.port || ""),
            ]));
            return;
        }
        // Add custom domain
        const result = await api.post(`/api/apps/${service.id}/domains`, {
            domain: hostname,
            port: opts.port,
        }).catch((err) => {
            if (err?.status === 404) {
                throw new Error("Domain endpoint not yet implemented. The API needs " +
                    "`POST /api/apps/{id}/domains` with body { domain, port }.");
            }
            throw err;
        });
        if (isJSONMode()) {
            printJSON(result);
        }
        else {
            success(`Domain ${chalk.cyan(hostname)} added`);
        }
    });
    dom
        .command("generate")
        .description("Generate a *.lizard.app subdomain")
        .option("-s, --service <name>", "Service name or ID")
        .option("-p, --project <id>", "Project name or ID")
        .action(async (opts, _sub) => {
        const projectId = resolveProjectId(opts.project);
        const service = await getActiveService(opts.service, projectId);
        const result = await api
            .post(`/api/apps/${service.id}/domains`, { generate: true })
            .catch((err) => {
            if (err?.status === 404) {
                throw new Error("Domain endpoint not yet implemented. The API needs " +
                    "`POST /api/apps/{id}/domains` with body { generate: true }.");
            }
            throw err;
        });
        if (isJSONMode()) {
            printJSON(result);
        }
        else {
            success(`Domain generated: ${chalk.cyan(`https://${result.domain}`)}`);
        }
    });
    dom
        .command("delete")
        .alias("rm")
        .argument("<hostname>", "Domain to remove")
        .description("Remove a domain")
        .option("-s, --service <name>", "Service name or ID")
        .option("-p, --project <id>", "Project name or ID")
        .action(async (hostname, opts) => {
        const projectId = resolveProjectId(opts.project);
        const service = await getActiveService(opts.service, projectId);
        await api
            .delete(`/api/apps/${service.id}/domains/${encodeURIComponent(hostname)}`)
            .catch((err) => {
            if (err?.status === 404) {
                throw new Error("Domain delete endpoint not yet implemented. The API needs " +
                    "`DELETE /api/apps/{id}/domains/{hostname}`.");
            }
            throw err;
        });
        if (isJSONMode()) {
            printJSON({ domain: hostname, status: "deleted" });
        }
        else {
            success(`Domain ${chalk.cyan(hostname)} removed`);
        }
    });
}
function parseIntOption(v) {
    const n = parseInt(v, 10);
    if (Number.isNaN(n))
        throw new Error(`Invalid number: ${v}`);
    return n;
}
//# sourceMappingURL=domain.js.map