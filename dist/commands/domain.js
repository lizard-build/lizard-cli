import chalk from "chalk";
import * as p from "@clack/prompts";
import { api } from "../lib/api.js";
import { resolveProjectId } from "../lib/config.js";
import { getActiveService } from "../lib/resolve.js";
import { success, isJSONMode, printJSON, isTTY } from "../lib/format.js";
/**
 * `lizard domain` — domain management.
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
        .option("-p, --project <id>", "Project name, slug, or ID")
        .option("--port <n>", "Port to expose", parseIntOption)
        .action(async (hostname, opts, _cmd) => {
        const projectId = await resolveProjectId(opts.project);
        const service = await getActiveService(opts.service, projectId);
        if (!hostname) {
            // Bare `lizard domain` — show or auto-generate.
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
        // Derive DNS records once, shared by both JSON and human output.
        // Names are relative to the registrable domain (what most provider
        // UIs expect); `fqdn` carries the full form for raw zones.
        const labels = hostname.split(".");
        const baseDomain = labels.length > 2 ? labels.slice(-2).join(".") : hostname;
        const relativeName = (full) => full === baseDomain
            ? "@"
            : full.endsWith(`.${baseDomain}`)
                ? full.slice(0, -(baseDomain.length + 1))
                : full;
        // When the apex is already verified for this account the API attaches the
        // domain immediately (autoVerified) and returns no TXT challenge — so the
        // TXT row only belongs in the output when there's actually a token.
        const txtFqdn = result.txtRecord || `_lizard-verify.${hostname}`;
        const dnsRecords = [
            ...(result.txtValue
                ? [
                    {
                        type: "TXT",
                        name: relativeName(txtFqdn),
                        fqdn: txtFqdn,
                        value: result.txtValue,
                    },
                ]
                : []),
            ...(result.cnameTarget
                ? [
                    {
                        type: "CNAME",
                        name: relativeName(hostname),
                        fqdn: hostname,
                        value: result.cnameTarget,
                    },
                ]
                : []),
        ];
        if (isJSONMode()) {
            printJSON({ ...result, baseDomain, dnsRecords });
            return;
        }
        const alreadyVerified = result.autoVerified || result.verified;
        // Custom domain — header reflects whether ownership still needs proving.
        if (alreadyVerified) {
            success(`Custom domain ${chalk.cyan(hostname)} attached (ownership already verified)`);
            console.log();
            console.log("  Add this DNS record at your provider to route traffic:");
        }
        else {
            success(`Custom domain ${chalk.cyan(hostname)} registered (pending verification)`);
            console.log();
            console.log("  Add these DNS records at your provider:");
        }
        console.log();
        const typeW = Math.max("TYPE".length, ...dnsRecords.map((r) => r.type.length));
        const nameW = Math.max("NAME".length, ...dnsRecords.map((r) => r.name.length));
        const pad = (s, w) => s + " ".repeat(w - s.length);
        console.log("    " + chalk.dim(`${pad("TYPE", typeW)}  ${pad("NAME", nameW)}  VALUE`));
        for (const { type, name, value } of dnsRecords) {
            console.log(`    ${pad(type, typeW)}  ${pad(name, nameW)}  ${chalk.cyan(value)}`);
        }
        console.log();
        console.log(chalk.dim(`    Names are relative to ${baseDomain}. If your provider asks for a full`));
        if (alreadyVerified) {
            console.log(chalk.dim(`    name, use ${hostname}.`));
        }
        else if (result.cnameTarget) {
            console.log(chalk.dim(`    name, use ${txtFqdn} and ${hostname}.`));
        }
        else {
            console.log(chalk.dim(`    name, use ${txtFqdn}.`));
        }
        console.log();
        if (alreadyVerified) {
            console.log(chalk.dim("  Domain is already active — no verification step needed."));
        }
        else {
            console.log(`  Then run:  ${chalk.cyan(`lizard domain verify ${hostname}`)}`);
        }
        console.log(chalk.dim("  HTTPS is issued automatically by Let's Encrypt on first request."));
    });
    // Subcommands intentionally don't redeclare -s/-p: Commander 14 binds a
    // duplicate short flag to the parent, leaving the subcommand action with
    // `opts.service === undefined`. Read parent values via optsWithGlobals().
    dom
        .command("generate")
        .description("Generate a fresh *.onlizard.com subdomain")
        .action(async (_opts, sub) => {
        const opts = sub.optsWithGlobals();
        const projectId = await resolveProjectId(opts.project);
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
        .command("verify")
        .argument("<hostname>", "Custom domain to verify")
        .description("Check the TXT record and activate the domain")
        .action(async (hostname, _opts, sub) => {
        const opts = sub.optsWithGlobals();
        const projectId = await resolveProjectId(opts.project);
        const service = await getActiveService(opts.service, projectId);
        const result = await api
            .post(`/api/apps/${service.id}/domains/verify`, { hostname })
            .catch((err) => {
            if (err?.status === 404) {
                throw new Error(`No pending verification for ${hostname}. Run \`lizard domain ${hostname}\` first.`);
            }
            throw err;
        });
        if (isJSONMode()) {
            printJSON(result);
            return;
        }
        if (result.verified) {
            success(`Domain ${chalk.cyan(hostname)} verified and active`);
            console.log(chalk.dim(`https://${hostname} — TLS issues on first HTTPS request.`));
        }
        else {
            console.log(chalk.yellow(`Not verified yet.`));
            if (result.message)
                console.log(chalk.dim(`  ${result.message}`));
        }
    });
    dom
        .command("delete")
        .alias("rm")
        .argument("<hostname>", "Domain to remove")
        .description("Remove a domain")
        .option("-y, --yes", "Skip confirmation")
        .action(async (hostname, _opts, sub) => {
        const opts = sub.optsWithGlobals();
        const projectId = await resolveProjectId(opts.project);
        const service = await getActiveService(opts.service, projectId);
        if (!opts.yes) {
            if (!isTTY())
                throw new Error("Use -y to confirm in non-interactive mode");
            const confirm = await p.confirm({
                message: `Remove domain ${chalk.bold(hostname)} from ${chalk.bold(service.name)}?`,
            });
            if (p.isCancel(confirm) || !confirm)
                process.exit(5);
        }
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