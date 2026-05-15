import chalk from "chalk";
import { api } from "../lib/api.js";
import { getProjectLink, resolveProjectId } from "../lib/config.js";
import { getActiveService } from "../lib/resolve.js";
import { success, isJSONMode, printJSON, table } from "../lib/format.js";
async function resolveScope(projectFlag, serviceFlag, global) {
    const projectId = resolveProjectId(projectFlag);
    if (global) {
        return { path: `/api/projects/${projectId}/secrets`, label: "project", projectId };
    }
    if (serviceFlag) {
        const svc = await getActiveService(serviceFlag, projectId);
        return {
            path: `/api/apps/${svc.id}/secrets`,
            label: "service",
            projectId,
            serviceId: svc.id,
        };
    }
    const link = getProjectLink();
    if (!link?.serviceId) {
        throw new Error("No service linked. Pass --service <name>, run `lizard service link <name>`, or use --global.");
    }
    return {
        path: `/api/apps/${link.serviceId}/secrets`,
        label: "service",
        projectId,
        serviceId: link.serviceId,
    };
}
/**
 * Apply secrets. Values are stored verbatim — including ${{name.KEY}} templates.
 * The platform's deployer expands templates against the project context at
 * deploy time. No client-side resolver needed.
 *
 * Merges with existing values; only keys in `newSecrets` are touched.
 */
async function applySecrets(scope, newSecrets, noRedeploy) {
    const existing = await api.get(scope.path);
    const map = new Map(existing.map((s) => [s.key, s.value]));
    for (const [k, v] of Object.entries(newSecrets))
        map.set(k, v);
    const merged = Array.from(map.entries()).map(([key, value]) => ({ key, value }));
    await api.put(scope.path, { secrets: merged, noRedeploy });
}
function parsePairs(pairs) {
    const out = {};
    for (const pair of pairs) {
        const eq = pair.indexOf("=");
        if (eq < 1)
            throw new Error(`Invalid format: "${pair}". Use KEY=value`);
        out[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
    return out;
}
export function registerSecrets(program) {
    const cmd = program
        .command("secrets")
        .alias("secret")
        .description("Manage secrets (default scope: service; use --global for project)")
        .option("--global", "Target the whole project")
        .option("--show", "Reveal values")
        .option("--set <kv...>", "KEY=value pairs to set (mutually exclusive with subcommands)")
        .option("--refs", "List reference templates available in this scope")
        .option("--no-redeploy", "Don't trigger redeploy on set/delete")
        .option("-s, --service <name>", "Service to scope to (overrides linked)")
        .option("-p, --project <id>", "Project to scope to")
        .option("-e, --environment <name>", "Environment to scope to")
        .action(async (opts) => {
        const scope = await resolveScope(opts.project ?? program.opts().project, opts.service, opts.global);
        // --refs → list reference templates exposed by the platform
        if (opts.refs) {
            await printRefs(scope);
            return;
        }
        // --set <kv...>
        if (opts.set?.length) {
            const newSecrets = parsePairs(opts.set);
            await applySecrets(scope, newSecrets, opts.redeploy === false);
            if (isJSONMode()) {
                printJSON({ updated: Object.keys(newSecrets), scope: scope.label });
            }
            else {
                success(`${Object.keys(newSecrets).length} ${scope.label} secret(s) updated`);
            }
            return;
        }
        // No --set → list
        const secrets = await api.get(scope.path);
        if (isJSONMode()) {
            printJSON(opts.show
                ? secrets
                : secrets.map((s) => ({ key: s.key, value: "***" })));
            return;
        }
        if (secrets.length === 0) {
            console.log(`No ${scope.label} secrets. Use \`lizard secrets --set KEY=value${opts.global ? " --global" : ""}\`.`);
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
        .option("--refs", "List reference templates available in this scope")
        .action(async (opts, sub) => {
        const inherited = sub.parent?.opts() || {};
        const scope = await resolveScope(opts.project ?? inherited.project ?? program.opts().project, opts.service ?? inherited.service, opts.global || inherited.global);
        if (opts.refs) {
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
        .option("--no-redeploy", "Don't trigger redeploy")
        .action(async (pairs, opts, sub) => {
        const inherited = sub.parent?.opts() || {};
        const scope = await resolveScope(opts.project ?? inherited.project ?? program.opts().project, opts.service ?? inherited.service, opts.global || inherited.global);
        const newSecrets = parsePairs(pairs);
        await applySecrets(scope, newSecrets, opts.redeploy === false);
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
        .option("--no-redeploy", "Don't trigger redeploy")
        .action(async (keys, opts, sub) => {
        const inherited = sub.parent?.opts() || {};
        const scope = await resolveScope(opts.project ?? inherited.project ?? program.opts().project, opts.service ?? inherited.service, opts.global || inherited.global);
        const existing = await api.get(scope.path);
        const set = new Set(keys);
        const filtered = existing.filter((s) => !set.has(s.key));
        if (filtered.length === existing.length) {
            throw new Error(`Secret(s) not found: ${keys.join(", ")}`);
        }
        await api.put(scope.path, {
            secrets: filtered,
            noRedeploy: opts.redeploy === false,
        });
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
        .option("--no-redeploy", "Don't trigger redeploy")
        .action(async (opts, sub) => {
        const inherited = sub.parent?.opts() || {};
        const scope = await resolveScope(opts.project ?? inherited.project ?? program.opts().project, opts.service ?? inherited.service, opts.global || inherited.global);
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
        const existing = await api.get(scope.path);
        const map = new Map(existing.map((s) => [s.key, s.value]));
        for (const [k, v] of Object.entries(newSecrets))
            map.set(k, v);
        const merged = Array.from(map.entries()).map(([key, value]) => ({ key, value }));
        await api.put(scope.path, {
            secrets: merged,
            noRedeploy: opts.redeploy === false,
        });
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
        ? `/api/apps/${scope.serviceId}/variables:refs`
        : `/api/projects/${scope.projectId}/variables:refs`;
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