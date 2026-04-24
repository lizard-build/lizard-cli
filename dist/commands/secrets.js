import chalk from "chalk";
import { api } from "../lib/api.js";
import { getProjectLink, resolveProjectId } from "../lib/config.js";
import { success, isJSONMode, printJSON, table } from "../lib/format.js";
/**
 * Return (scopePath, label) pair for secret endpoints.
 * - --global → project-wide: /api/projects/{id}/secrets
 * - default  → service-wide: /api/apps/{id}/secrets
 *
 * Throws a helpful error when service scope is requested but no app is linked
 * to the current directory.
 */
function resolveScope(projectFlag, global) {
    if (global) {
        const projectId = resolveProjectId(projectFlag);
        return { path: `/api/projects/${projectId}/secrets`, label: "project" };
    }
    const link = getProjectLink();
    if (!link?.appId) {
        throw new Error("No service linked to this directory. Run `lizard deploy` first, or use --global to target the whole project.");
    }
    return { path: `/api/apps/${link.appId}/secrets`, label: "service" };
}
function parsePairs(pairs) {
    const out = {};
    for (const pair of pairs) {
        const eqIdx = pair.indexOf("=");
        if (eqIdx < 1) {
            throw new Error(`Invalid format: "${pair}". Use KEY=value`);
        }
        out[pair.slice(0, eqIdx)] = pair.slice(eqIdx + 1);
    }
    return out;
}
export function registerSecrets(program) {
    const secret = program
        .command("secret")
        .description("Manage secrets (default scope: service; use --global for project)");
    secret
        .command("list")
        .description("List secrets")
        .option("--global", "Target the whole project instead of the linked service")
        .option("--show", "Reveal secret values")
        .action(async (opts) => {
        const scope = resolveScope(program.opts().project, opts.global);
        const secrets = await api.get(scope.path);
        if (isJSONMode()) {
            printJSON(opts.show
                ? secrets
                : secrets.map((s) => ({ key: s.key, value: "***" })));
            return;
        }
        if (secrets.length === 0) {
            console.log(`No ${scope.label} secrets. Use \`lizard secret set KEY=value${opts.global ? " --global" : ""}\`.`);
            return;
        }
        table(["Key", "Value"], secrets.map((s) => [
            s.key,
            opts.show ? s.value : chalk.dim("•".repeat(Math.min(s.value.length, 20))),
        ]));
    });
    secret
        .command("set")
        .argument("<pairs...>", "KEY=value pairs")
        .description("Set one or more secrets")
        .option("--global", "Target the whole project instead of the linked service")
        .option("--no-redeploy", "Don't trigger redeploy")
        .action(async (pairs, opts) => {
        const scope = resolveScope(program.opts().project, opts.global);
        const newSecrets = parsePairs(pairs);
        const existing = await api.get(scope.path);
        const existingKeys = new Set();
        const merged = [];
        for (const s of existing) {
            if (newSecrets[s.key] !== undefined) {
                merged.push({ key: s.key, value: newSecrets[s.key] });
                existingKeys.add(s.key);
            }
            else {
                merged.push(s);
            }
        }
        for (const [key, value] of Object.entries(newSecrets)) {
            if (!existingKeys.has(key))
                merged.push({ key, value });
        }
        await api.put(scope.path, {
            secrets: merged,
            noRedeploy: opts.redeploy === false,
        });
        if (isJSONMode()) {
            printJSON({ updated: Object.keys(newSecrets), scope: scope.label });
        }
        else {
            success(`${Object.keys(newSecrets).length} ${scope.label} secret(s) updated`);
        }
    });
    secret
        .command("delete")
        .argument("<keys...>", "Secret keys to delete")
        .description("Delete one or more secrets")
        .option("--global", "Target the whole project instead of the linked service")
        .option("--no-redeploy", "Don't trigger redeploy")
        .action(async (keys, opts) => {
        const scope = resolveScope(program.opts().project, opts.global);
        const existing = await api.get(scope.path);
        const keysSet = new Set(keys);
        const filtered = existing.filter((s) => !keysSet.has(s.key));
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
    secret
        .command("import")
        .description("Import secrets from stdin (KEY=value, one per line)")
        .option("--global", "Target the whole project instead of the linked service")
        .option("--no-redeploy", "Don't trigger redeploy")
        .action(async (opts) => {
        const scope = resolveScope(program.opts().project, opts.global);
        const chunks = [];
        for await (const chunk of process.stdin) {
            chunks.push(chunk);
        }
        const input = Buffer.concat(chunks).toString("utf-8");
        const newSecrets = {};
        for (const line of input.split("\n")) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith("#"))
                continue;
            const eqIdx = trimmed.indexOf("=");
            if (eqIdx < 1)
                continue;
            newSecrets[trimmed.slice(0, eqIdx)] = trimmed.slice(eqIdx + 1);
        }
        if (Object.keys(newSecrets).length === 0) {
            throw new Error("No valid KEY=value pairs found in input");
        }
        const existing = await api.get(scope.path);
        const existingMap = new Map(existing.map((s) => [s.key, s.value]));
        for (const [k, v] of Object.entries(newSecrets)) {
            existingMap.set(k, v);
        }
        const merged = Array.from(existingMap.entries()).map(([key, value]) => ({
            key,
            value,
        }));
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
//# sourceMappingURL=secrets.js.map