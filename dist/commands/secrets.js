import chalk from "chalk";
import * as p from "@clack/prompts";
import { Option } from "commander";
import { api, withScope } from "../lib/api.js";
import { getProjectLink } from "../lib/config.js";
import { getActiveService, resolveProjectScope } from "../lib/resolve.js";
import { success, isJSONMode, printJSON, table, isTTY } from "../lib/format.js";
async function resolveScope(projectFlag, serviceFlag, global) {
    const { projectId, scope: rs } = await resolveProjectScope(projectFlag);
    if (global) {
        return {
            path: withScope(`/api/projects/${projectId}/secrets`, rs),
            label: "project",
            projectId,
            scope: rs,
        };
    }
    if (serviceFlag) {
        const svc = await getActiveService(serviceFlag, projectId);
        return {
            path: withScope(`/api/apps/${svc.id}/secrets`, rs),
            label: "service",
            projectId,
            serviceId: svc.id,
            serviceName: svc.name,
            scope: rs,
        };
    }
    const link = getProjectLink();
    if (!link?.serviceId) {
        throw new Error("No service linked. Pass --service <name>, run `lizard service link <name>`, or use --global.");
    }
    return {
        path: withScope(`/api/apps/${link.serviceId}/secrets`, rs),
        label: "service",
        projectId,
        serviceId: link.serviceId,
        serviceName: link.serviceName || link.serviceId,
        scope: rs,
    };
}
async function configApplySecrets(scope, secrets) {
    const payload = scope.label === "project"
        ? { secrets: { shared: secrets } }
        : { secrets: { services: { [scope.serviceName]: secrets } } };
    await api.post(withScope(`/api/projects/${scope.projectId}/config:apply`, scope.scope), payload);
}
function parsePairs(pairs) {
    const out = {};
    for (const pair of pairs) {
        const eq = pair.indexOf("=");
        if (eq < 1) {
            throw new Error(`Invalid format: "${pair}". Use KEY=value (e.g. \`lizard secrets set DATABASE_URL=postgres://...\`).`);
        }
        out[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
    return out;
}
export function registerSecrets(program) {
    const cmd = program
        .command("secrets")
        .alias("secret")
        .description("Manage secrets (default scope: service; --global for project)")
        .option("--global", "Target the whole project")
        .option("--show", "Reveal values")
        .option("--ref", "List reference templates available in this scope")
        .addOption(new Option("--refs").hideHelp().implies({ ref: true }))
        .option("-s, --service <name>", "Service to scope to (overrides linked)")
        .option("-p, --project <id>", "Project to scope to")
        .addHelpText("after", `
Notes:
  Secrets apply live to running VMs. Keys prefixed with NEXT_PUBLIC_* or VITE_*
  trigger a redeploy because they're baked into the client bundle at build time.`)
        .action(async (opts) => {
        const scope = await resolveScope(opts.project, opts.service, opts.global);
        // --ref → list reference templates exposed by the platform
        if (opts.ref) {
            await printRefs(scope);
            return;
        }
        const secrets = await api.get(scope.path);
        if (isJSONMode()) {
            printJSON(opts.show
                ? secrets
                : secrets.map((s) => ({ key: s.key, value: "***" })));
            return;
        }
        if (secrets.length === 0) {
            console.log(`No ${scope.label} secrets. Use \`lizard secrets set KEY=value${opts.global ? " --global" : ""}\`.`);
            return;
        }
        table(["Key", "Value"], secrets.map((s) => [
            s.key,
            opts.show
                ? s.value
                : chalk.dim("•".repeat(Math.min(s.value.length, 20))),
        ]));
    });
    cmd
        .command("list")
        .description("List secrets")
        .option("--global", "Target the whole project")
        .option("--show", "Reveal values")
        .option("--ref", "List reference templates available in this scope")
        .addOption(new Option("--refs").hideHelp().implies({ ref: true }))
        .option("-s, --service <name>", "Service to scope to (overrides linked)")
        .option("-p, --project <id>", "Project to scope to")
        .action(async (opts, sub) => {
        const inherited = sub.parent?.opts() || {};
        const scope = await resolveScope(opts.project ?? inherited.project, opts.service ?? inherited.service, opts.global || inherited.global);
        if (opts.ref) {
            await printRefs(scope);
            return;
        }
        const secrets = await api.get(scope.path);
        if (isJSONMode()) {
            printJSON(opts.show
                ? secrets
                : secrets.map((s) => ({ key: s.key, value: "***" })));
            return;
        }
        if (secrets.length === 0) {
            console.log(`No ${scope.label} secrets.`);
            return;
        }
        table(["Key", "Value"], secrets.map((s) => [
            s.key,
            opts.show
                ? s.value
                : chalk.dim("•".repeat(Math.min(s.value.length, 20))),
        ]));
    });
    cmd
        .command("set")
        .argument("<pairs...>", "KEY=value pairs")
        .description("Set one or more secrets")
        .option("--global", "Target the whole project")
        .option("-s, --service <name>", "Service to scope to (overrides linked)")
        .option("-p, --project <id>", "Project to scope to")
        .action(async (pairs, opts, sub) => {
        const inherited = sub.parent?.opts() || {};
        const scope = await resolveScope(opts.project ?? inherited.project, opts.service ?? inherited.service, opts.global || inherited.global);
        const newSecrets = parsePairs(pairs);
        await configApplySecrets(scope, newSecrets);
        if (isJSONMode()) {
            printJSON({ updated: Object.keys(newSecrets), scope: scope.label });
        }
        else {
            success(`${Object.keys(newSecrets).length} ${scope.label} secret(s) updated`);
        }
    });
    cmd
        .command("delete")
        .alias("rm")
        .argument("<keys...>", "Secret keys to delete")
        .description("Delete one or more secrets")
        .option("--global", "Target the whole project")
        .option("-y, --yes", "Skip confirmation")
        .option("-s, --service <name>", "Service to scope to (overrides linked)")
        .option("-p, --project <id>", "Project to scope to")
        .action(async (keys, opts, sub) => {
        const inherited = sub.parent?.opts() || {};
        const scope = await resolveScope(opts.project ?? inherited.project, opts.service ?? inherited.service, opts.global || inherited.global);
        const existing = await api.get(scope.path);
        const existingKeys = new Set(existing.map((s) => s.key));
        const notFound = keys.filter((k) => !existingKeys.has(k));
        if (notFound.length > 0) {
            throw new Error(`Secret(s) not found: ${notFound.join(", ")}`);
        }
        if (!opts.yes) {
            if (!isTTY())
                throw new Error("Use -y to confirm in non-interactive mode");
            const summary = keys.length === 1 ? chalk.bold(keys[0]) : `${keys.length} keys`;
            const confirm = await p.confirm({
                message: `Delete ${summary} from ${chalk.bold(scope.label)} scope?`,
            });
            if (p.isCancel(confirm) || !confirm)
                process.exit(5);
        }
        const deletePayload = {};
        keys.forEach((k) => { deletePayload[k] = null; });
        await configApplySecrets(scope, deletePayload);
        if (isJSONMode()) {
            printJSON({ deleted: keys, scope: scope.label });
        }
        else {
            success(`${keys.length} ${scope.label} secret(s) deleted`);
        }
    });
    cmd
        .command("import")
        .description("Import secrets from stdin (KEY=value, one per line)")
        .option("--global", "Target the whole project")
        .option("-s, --service <name>", "Service to scope to (overrides linked)")
        .option("-p, --project <id>", "Project to scope to")
        .action(async (opts, sub) => {
        // Reading a TTY stdin waits for Ctrl+D forever — fail fast instead.
        if (process.stdin.isTTY) {
            throw new Error("secrets import reads KEY=value lines from stdin. Pipe a file:\n" +
                "  lizard secrets import < .env");
        }
        const inherited = sub.parent?.opts() || {};
        const scope = await resolveScope(opts.project ?? inherited.project, opts.service ?? inherited.service, opts.global || inherited.global);
        const chunks = [];
        for await (const chunk of process.stdin)
            chunks.push(chunk);
        const input = Buffer.concat(chunks).toString("utf-8");
        const newSecrets = {};
        for (const line of input.split("\n")) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith("#"))
                continue;
            const eq = trimmed.indexOf("=");
            if (eq < 1)
                continue;
            newSecrets[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
        }
        if (!Object.keys(newSecrets).length) {
            throw new Error("No valid KEY=value pairs in input");
        }
        await configApplySecrets(scope, newSecrets);
        if (isJSONMode()) {
            printJSON({ imported: Object.keys(newSecrets), scope: scope.label });
        }
        else {
            success(`${Object.keys(newSecrets).length} ${scope.label} secret(s) imported`);
        }
    });
}
/**
 * Fetch the reference manifest from the backend so users know which
 * `${{...}}` templates are valid (e.g. `${{Postgres.DATABASE_URL}}`,
 * `${{api.LIZARD_PUBLIC_DOMAIN}}`). Backend endpoint:
 *   GET /api/projects/<id>/variables:refs
 *   GET /api/apps/<id>/variables:refs       (for service-scope)
 *
 * Returns a flat list of templates ready to copy-paste into secret values.
 */
async function printRefs(scope) {
    const endpoint = scope.label === "service" && scope.serviceId
        ? withScope(`/api/apps/${scope.serviceId}/variables:refs`, scope.scope)
        : withScope(`/api/projects/${scope.projectId}/variables:refs`, scope.scope);
    const refs = await api.get(endpoint);
    if (isJSONMode()) {
        printJSON(refs);
        return;
    }
    if (!refs.length) {
        console.log("No reference variables exposed in this scope.");
        return;
    }
    table(["Template", "Source", "Description"], refs.map((r) => [chalk.cyan(r.template), r.source || "—", r.description || ""]));
}
//# sourceMappingURL=secrets.js.map