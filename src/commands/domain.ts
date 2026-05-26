import chalk from "chalk";
import * as p from "@clack/prompts";
import { Command } from "commander";
import { api } from "../lib/api.js";
import { resolveProjectId } from "../lib/config.js";
import { getActiveService } from "../lib/resolve.js";
import { success, isJSONMode, printJSON, table, isTTY } from "../lib/format.js";

interface DomainResponse {
  ok?: boolean;
  hostname: string;
  generated?: boolean;
  verified?: boolean;
  txtRecord?: string;
  txtValue?: string;
  cnameTarget?: string;
}

interface AppLite {
  id: string;
  name: string;
  domain?: string | null;
  containerPort?: number | null;
}

/**
 * `lizard domain` — domain management.
 *   bare         → if no domain, auto-generate one; otherwise show current
 *   <hostname>   → attach a custom domain
 *   delete <h>   → remove a domain
 *   generate     → force-generate a fresh *.onlizard.com subdomain
 */
export function registerDomain(program: Command) {
  const dom = program
    .command("domain")
    .alias("domains")
    .argument("[hostname]", "Custom domain to attach (e.g. app.example.com)")
    .description("Manage service domains")
    .option("-s, --service <name>", "Service name or ID")
    .option("-p, --project <id>", "Project name, slug, or ID")
    .option("--port <n>", "Port to expose", parseIntOption)
    .action(async (hostname: string | undefined, opts, _cmd) => {
      const projectId = await resolveProjectId(opts.project);
      const service = await getActiveService(opts.service, projectId);

      if (!hostname) {
        // Bare `lizard domain` — show or auto-generate.
        const appRow = await api
          .get<AppLite>(`/api/apps/${service.id}`)
          .catch(() => null);
        const existing = appRow?.domain;

        if (existing) {
          if (isJSONMode()) {
            printJSON({ hostname: existing, generated: false });
          } else {
            console.log(chalk.cyan(`https://${existing}`));
            console.log(
              chalk.dim(
                `  Reference from other services: ${chalk.cyan(`\${{${service.name}.LIZARD_PUBLIC_DOMAIN}}`)}`,
              ),
            );
          }
          return;
        }

        const result = await api
          .post<DomainResponse>(`/api/apps/${service.id}/domains`, { generate: true })
          .catch((err: any) => {
            if (err?.status === 404) {
              throw new Error(
                "Domain endpoint not yet implemented. The API needs " +
                  "`POST /api/apps/{id}/domains` with body { generate: true }.",
              );
            }
            throw err;
          });

        if (isJSONMode()) {
          printJSON(result);
        } else {
          success(`Domain generated: ${chalk.cyan(`https://${result.hostname}`)}`);
          console.log(
            chalk.dim(
              `  Reference from other services: ${chalk.cyan(`\${{${service.name}.LIZARD_PUBLIC_DOMAIN}}`)}`,
            ),
          );
        }
        return;
      }

      // Attach custom hostname
      const result = await api
        .post<DomainResponse>(`/api/apps/${service.id}/domains`, {
          hostname,
          port: opts.port,
        })
        .catch((err: any) => {
          if (err?.status === 404) {
            throw new Error(
              "Domain endpoint not yet implemented. The API needs " +
                "`POST /api/apps/{id}/domains` with body { hostname }.",
            );
          }
          throw err;
        });

      if (isJSONMode()) {
        printJSON(result);
        return;
      }

      // Custom domain — print verification + DNS instructions
      success(`Custom domain ${chalk.cyan(hostname)} registered (pending verification)`);
      console.log();
      console.log(chalk.bold("1) Verify ownership — add this TXT record at your DNS provider:"));
      console.log(`     ${chalk.dim("Name: ")}${chalk.cyan(result.txtRecord || `_lizard-verify.${hostname}`)}`);
      console.log(`     ${chalk.dim("Value:")} ${chalk.cyan(result.txtValue || "")}`);
      console.log();
      if (result.cnameTarget) {
        console.log(chalk.bold("2) Point traffic — add this CNAME record:"));
        console.log(`     ${chalk.dim("Name: ")}${chalk.cyan(hostname)}`);
        console.log(`     ${chalk.dim("Value:")} ${chalk.cyan(result.cnameTarget)}`);
        console.log(chalk.dim(`     (${result.cnameTarget} is a multi-A record across all load balancers — no IP to track.)`));
        console.log();
      }
      console.log(chalk.bold("3) Once both records propagate, run:"));
      console.log(`     ${chalk.cyan(`lizard domain verify ${hostname}`)}`);
      console.log();
      console.log(chalk.dim("HTTPS certificate will be issued automatically by Let's Encrypt on first request."));
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
        .post<DomainResponse>(`/api/apps/${service.id}/domains`, { generate: true })
        .catch((err: any) => {
          if (err?.status === 404) {
            throw new Error(
              "Domain endpoint not yet implemented. The API needs " +
                "`POST /api/apps/{id}/domains` with body { generate: true }.",
            );
          }
          throw err;
        });

      if (isJSONMode()) {
        printJSON(result);
      } else {
        success(`Domain generated: ${chalk.cyan(`https://${result.hostname}`)}`);
        console.log(
          chalk.dim(
            `  Reference from other services: ${chalk.cyan(`\${{${service.name}.LIZARD_PUBLIC_DOMAIN}}`)}`,
          ),
        );
      }
    });

  dom
    .command("verify")
    .argument("<hostname>", "Custom domain to verify")
    .description("Check the TXT record and activate the domain")
    .action(async (hostname: string, _opts, sub) => {
      const opts = sub.optsWithGlobals();
      const projectId = await resolveProjectId(opts.project);
      const service = await getActiveService(opts.service, projectId);

      const result = await api
        .post<{ ok: boolean; verified: boolean; hostname?: string; message?: string }>(
          `/api/apps/${service.id}/domains/verify`,
          { hostname },
        )
        .catch((err: any) => {
          if (err?.status === 404) {
            throw new Error(
              `No pending verification for ${hostname}. Run \`lizard domain ${hostname}\` first.`,
            );
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
      } else {
        console.log(chalk.yellow(`Not verified yet.`));
        if (result.message) console.log(chalk.dim(`  ${result.message}`));
      }
    });

  dom
    .command("delete")
    .alias("rm")
    .argument("<hostname>", "Domain to remove")
    .description("Remove a domain")
    .option("-y, --yes", "Skip confirmation")
    .action(async (hostname: string, _opts, sub) => {
      const opts = sub.optsWithGlobals();
      const projectId = await resolveProjectId(opts.project);
      const service = await getActiveService(opts.service, projectId);

      if (!opts.yes) {
        if (!isTTY()) throw new Error("Use -y to confirm in non-interactive mode");
        const confirm = await p.confirm({
          message: `Remove domain ${chalk.bold(hostname)} from ${chalk.bold(service.name)}?`,
        });
        if (p.isCancel(confirm) || !confirm) process.exit(5);
      }

      await api
        .delete(`/api/apps/${service.id}/domains/${encodeURIComponent(hostname)}`)
        .catch((err: any) => {
          if (err?.status === 404) {
            throw new Error(
              "Domain delete endpoint not yet implemented. The API needs " +
                "`DELETE /api/apps/{id}/domains/{hostname}`.",
            );
          }
          throw err;
        });

      if (isJSONMode()) {
        printJSON({ domain: hostname, status: "deleted" });
      } else {
        success(`Domain ${chalk.cyan(hostname)} removed`);
      }
    });
}

function parseIntOption(v: string): number {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) throw new Error(`Invalid number: ${v}`);
  return n;
}
