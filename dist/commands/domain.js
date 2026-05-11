import chalk from "chalk";
import { api } from "../lib/api.js";
import { resolveProjectId } from "../lib/config.js";
import { getActiveService } from "../lib/resolve.js";
import { success, isJSONMode, printJSON } from "../lib/format.js";
/**
 * `lizard domain` — Railway-style domain management.
 *   bare         → if no domain, auto-generate one; otherwise show current
 *   <hostname>   → attach a custom domain
 *   delete <h>   → remove a domain
 *   generate     → force-generate a fresh *.onlizard.com subdomain
 */
export function registerDomain(program) {
    const dom = program
        .command("domain")
        .alias("domains")
        .argument("[hostname]", "Custom domain to attach (e.g. app.example.com)")
        .description("Manage service domains")
        .option("-s, --service <name>", "Service name or ID")
        .option("-p, --project <id>", "Project name or ID")
        .option("-e, --environment <name>", "Environment name or ID")
        .option("--port <n>", "Port to expose", parseIntOption)
        .action(async (hostname, opts, _cmd) => {
        const projectId = resolveProjectId(opts.project);
        const service = await getActiveService(opts.service, projectId);
        if (!hostname) {
            // Bare `lizard domain` — Railway-compat: show or auto-generate.
            const appRow = await api
                .get(`/api/apps/${service.id}`)
                .catch(() => null);
            const existing = appRow?.domain;
            if (existing) {
                if (isJSONMode()) {
                    printJSON({ hostname: existing, generated: false });
                }
                else {
                    console.log(chalk.cyan(`https://${existing}`));
                    console.log(chalk.dim(`  Reference from other services: ${chalk.cyan(`\${{${service.name}.LIZARD_PUBLIC_DOMAIN}}`)}`));
                }
                return;
            }
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
                success(`Domain generated: ${chalk.cyan(`https://${result.hostname}`)}`);
                console.log(chalk.dim(`  Reference from other services: ${chalk.cyan(`\${{${service.name}.LIZARD_PUBLIC_DOMAIN}}`)}`));
            }
            return;
        }
        // Attach custom hostname
        const result = await api
            .post(`/api/apps/${service.id}/domains`, {
            hostname,
            port: opts.port,
        })
            .catch((err) => {
            if (err?.status === 404) {
                throw new Error("Domain endpoint not yet implemented. The API needs " +
                    "`POST /api/apps/{id}/domains` with body { hostname }.");
            }
            throw err;
        });
        if (isJSONMode()) {
            printJSON(result);
        }
        else {
            success(`Domain ${chalk.cyan(hostname)} attached`);
        }
    });
    // Subcommands intentionally don't redeclare -s/-p: Commander 14 binds a
    // duplicate short flag to the parent, leaving the subcommand action with
    // `opts.service === undefined`. Read parent values via optsWithGlobals().
    dom
        .command("generate")
        .description("Generate a fresh *.onlizard.com subdomain")
        .action(async (_opts, sub) => {
        const opts = sub.optsWithGlobals();
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
            success(`Domain generated: ${chalk.cyan(`https://${result.hostname}`)}`);
            console.log(chalk.dim(`  Reference from other services: ${chalk.cyan(`\${{${service.name}.LIZARD_PUBLIC_DOMAIN}}`)}`));
        }
    });
    dom
        .command("delete")
        .alias("rm")
        .argument("<hostname>", "Domain to remove")
        .description("Remove a domain")
        .action(async (hostname, _opts, sub) => {
        const opts = sub.optsWithGlobals();
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