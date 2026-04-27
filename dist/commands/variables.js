import chalk from "chalk";
import { api } from "../lib/api.js";
import { getProjectLink, resolveProjectId } from "../lib/config.js";
import { getActiveService } from "../lib/resolve.js";
import { success, isJSONMode, printJSON, table } from "../lib/format.js";
/**
 * `lizard variables` — Railway-style variable management. Defaults to
 * the linked service scope, with --global for project-wide.
 *
 * Bare command without subcommand prints the variable list (mirrors
 * `railway variables`).
 *
 * `--set KEY=value [...]` is the inline-set form.
 */
async function resolveScope(projectFlag, serviceFlag, global) {
    if (global) {
        const projectId = resolveProjectId(projectFlag);
        return { path: `/api/projects/${projectId}/secrets`, label: "project" };
    }
    const projectId = resolveProjectId(projectFlag);
    if (serviceFlag) {
        const svc = await getActiveService(serviceFlag, projectId);
        return { path: `/api/apps/${svc.id}/secrets`, label: "service" };
    }
    const link = getProjectLink();
    if (!link?.serviceId) {
        throw new Error("No service linked. Pass --service <name>, run `lizard service link <name>`, or use --global.");
    }
    return { path: `/api/apps/${link.serviceId}/secrets`, label: "service" };
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
export function registerVariables(program) {
    const cmd = program
        .command("variables")
        .alias("vars")
        .description("Manage variables (default scope: service; use --global for project)")
        .option("--global", "Target the whole project")
        .option("--show", "Reveal values")
        .option("--set <kv...>", "KEY=value pairs to set (mutually exclusive with subcommands)")
        .option("--no-redeploy", "Don't trigger redeploy on set/delete")
        .option("-s, --service <name>", "Service to scope to (overrides linked)")
        .option("-p, --project <id>", "Project to scope to")
        .option("-e, --environment <name>", "Environment to scope to")
        .action(async (opts) => {
        const scope = await resolveScope(opts.project ?? program.opts().project, opts.service, opts.global);
        // --set <kv...>
        if (opts.set?.length) {
            const newVars = parsePairs(opts.set);
            const existing = await api.get(scope.path);
            const map = new Map(existing.map((s) => [s.key, s.value]));
            for (const [k, v] of Object.entries(newVars))
                map.set(k, v);
            const merged = Array.from(map.entries()).map(([key, value]) => ({ key, value }));
            await api.put(scope.path, {
                secrets: merged,
                noRedeploy: opts.redeploy === false,
            });
            if (isJSONMode()) {
                printJSON({ updated: Object.keys(newVars), scope: scope.label });
            }
            else {
                success(`${Object.keys(newVars).length} ${scope.label} variable(s) updated`);
            }
            return;
        }
        // No --set → list
        const variables = await api.get(scope.path);
        if (isJSONMode()) {
            printJSON(opts.show
                ? variables
                : variables.map((v) => ({ key: v.key, value: "***" })));
            return;
        }
        if (variables.length === 0) {
            console.log(`No ${scope.label} variables. Use \`lizard variables --set KEY=value${opts.global ? " --global" : ""}\`.`);
            return;
        }
        table(["Key", "Value"], variables.map((v) => [
            v.key,
            opts.show
                ? v.value
                : chalk.dim("•".repeat(Math.min(v.value.length, 20))),
        ]));
    });
    // Subcommands for compatibility with `lizard secret list/set/delete/import`
    cmd
        .command("list")
        .description("List variables")
        .option("--global", "Target the whole project")
        .option("--show", "Reveal values")
        .action(async (opts, sub) => {
        const inherited = sub.parent?.opts() || {};
        const scope = await resolveScope(opts.project ?? inherited.project ?? program.opts().project, opts.service ?? inherited.service, opts.global || inherited.global);
        const variables = await api.get(scope.path);
        if (isJSONMode()) {
            printJSON(opts.show
                ? variables
                : variables.map((v) => ({ key: v.key, value: "***" })));
            return;
        }
        if (variables.length === 0) {
            console.log(`No ${scope.label} variables.`);
            return;
        }
        table(["Key", "Value"], variables.map((v) => [
            v.key,
            opts.show
                ? v.value
                : chalk.dim("•".repeat(Math.min(v.value.length, 20))),
        ]));
    });
    cmd
        .command("set")
        .argument("<pairs...>", "KEY=value pairs")
        .description("Set one or more variables")
        .option("--global", "Target the whole project")
        .option("--no-redeploy", "Don't trigger redeploy")
        .action(async (pairs, opts, sub) => {
        const inherited = sub.parent?.opts() || {};
        const scope = await resolveScope(opts.project ?? inherited.project ?? program.opts().project, opts.service ?? inherited.service, opts.global || inherited.global);
        const newVars = parsePairs(pairs);
        const existing = await api.get(scope.path);
        const map = new Map(existing.map((s) => [s.key, s.value]));
        for (const [k, v] of Object.entries(newVars))
            map.set(k, v);
        const merged = Array.from(map.entries()).map(([key, value]) => ({ key, value }));
        await api.put(scope.path, {
            secrets: merged,
            noRedeploy: opts.redeploy === false,
        });
        if (isJSONMode()) {
            printJSON({ updated: Object.keys(newVars), scope: scope.label });
        }
        else {
            success(`${Object.keys(newVars).length} ${scope.label} variable(s) updated`);
        }
    });
    cmd
        .command("delete")
        .alias("rm")
        .argument("<keys...>", "Variable keys to delete")
        .description("Delete one or more variables")
        .option("--global", "Target the whole project")
        .option("--no-redeploy", "Don't trigger redeploy")
        .action(async (keys, opts, sub) => {
        const inherited = sub.parent?.opts() || {};
        const scope = await resolveScope(opts.project ?? inherited.project ?? program.opts().project, opts.service ?? inherited.service, opts.global || inherited.global);
        const existing = await api.get(scope.path);
        const set = new Set(keys);
        const filtered = existing.filter((s) => !set.has(s.key));
        if (filtered.length === existing.length) {
            throw new Error(`Variable(s) not found: ${keys.join(", ")}`);
        }
        await api.put(scope.path, {
            secrets: filtered,
            noRedeploy: opts.redeploy === false,
        });
        if (isJSONMode()) {
            printJSON({ deleted: keys, scope: scope.label });
        }
        else {
            success(`${keys.length} ${scope.label} variable(s) deleted`);
        }
    });
    cmd
        .command("import")
        .description("Import variables from stdin (KEY=value, one per line)")
        .option("--global", "Target the whole project")
        .option("--no-redeploy", "Don't trigger redeploy")
        .action(async (opts, sub) => {
        const inherited = sub.parent?.opts() || {};
        const scope = await resolveScope(opts.project ?? inherited.project ?? program.opts().project, opts.service ?? inherited.service, opts.global || inherited.global);
        const chunks = [];
        for await (const chunk of process.stdin)
            chunks.push(chunk);
        const input = Buffer.concat(chunks).toString("utf-8");
        const newVars = {};
        for (const line of input.split("\n")) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith("#"))
                continue;
            const eq = trimmed.indexOf("=");
            if (eq < 1)
                continue;
            newVars[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
        }
        if (!Object.keys(newVars).length) {
            throw new Error("No valid KEY=value pairs in input");
        }
        const existing = await api.get(scope.path);
        const map = new Map(existing.map((s) => [s.key, s.value]));
        for (const [k, v] of Object.entries(newVars))
            map.set(k, v);
        const merged = Array.from(map.entries()).map(([key, value]) => ({ key, value }));
        await api.put(scope.path, {
            secrets: merged,
            noRedeploy: opts.redeploy === false,
        });
        if (isJSONMode()) {
            printJSON({ imported: Object.keys(newVars), scope: scope.label });
        }
        else {
            success(`${Object.keys(newVars).length} ${scope.label} variable(s) imported`);
        }
    });
}
//# sourceMappingURL=variables.js.map