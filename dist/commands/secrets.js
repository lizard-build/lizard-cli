import chalk from "chalk";
import { api } from "../lib/api.js";
import { resolveProjectId } from "../lib/config.js";
import { success, isJSONMode, printJSON, table } from "../lib/format.js";
export function registerSecrets(program) {
    const secret = program
        .command("secret")
        .description("Manage project secrets");
    secret
        .command("list")
        .description("List project secrets")
        .option("--show", "Reveal secret values")
        .action(async (opts) => {
        const projectId = resolveProjectId(program.opts().project);
        const secrets = await api.get(`/api/projects/${projectId}/secrets`);
        if (isJSONMode()) {
            printJSON(opts.show
                ? secrets
                : secrets.map((s) => ({ key: s.key, value: "***" })));
            return;
        }
        if (secrets.length === 0) {
            console.log("No secrets. Use `lizard secret set KEY=value`.");
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
        .option("--no-redeploy", "Don't trigger redeploy")
        .action(async (pairs, opts) => {
        const projectId = resolveProjectId(program.opts().project);
        // Parse KEY=value pairs
        const newSecrets = {};
        for (const pair of pairs) {
            const eqIdx = pair.indexOf("=");
            if (eqIdx < 1) {
                throw new Error(`Invalid format: "${pair}". Use KEY=value`);
            }
            newSecrets[pair.slice(0, eqIdx)] = pair.slice(eqIdx + 1);
        }
        // Get existing secrets, merge, update
        const existing = await api.get(`/api/projects/${projectId}/secrets`);
        const merged = [];
        const existingKeys = new Set();
        for (const s of existing) {
            if (newSecrets[s.key] !== undefined) {
                merged.push({ key: s.key, value: newSecrets[s.key] });
                existingKeys.add(s.key);
            }
            else {
                merged.push(s);
            }
        }
        // Add new keys
        for (const [key, value] of Object.entries(newSecrets)) {
            if (!existingKeys.has(key)) {
                merged.push({ key, value });
            }
        }
        await api.put(`/api/projects/${projectId}/secrets`, merged);
        if (isJSONMode()) {
            printJSON({ updated: Object.keys(newSecrets) });
        }
        else {
            success(`${Object.keys(newSecrets).length} secret(s) updated`);
        }
    });
    secret
        .command("delete")
        .argument("<keys...>", "Secret keys to delete")
        .description("Delete one or more secrets")
        .action(async (keys) => {
        const projectId = resolveProjectId(program.opts().project);
        const existing = await api.get(`/api/projects/${projectId}/secrets`);
        const keysSet = new Set(keys);
        const filtered = existing.filter((s) => !keysSet.has(s.key));
        if (filtered.length === existing.length) {
            throw new Error(`Secret(s) not found: ${keys.join(", ")}`);
        }
        await api.put(`/api/projects/${projectId}/secrets`, filtered);
        if (isJSONMode()) {
            printJSON({ deleted: keys });
        }
        else {
            success(`${keys.length} secret(s) deleted`);
        }
    });
    secret
        .command("import")
        .description("Import secrets from stdin (KEY=value format, one per line)")
        .option("--no-redeploy", "Don't trigger redeploy")
        .action(async () => {
        const projectId = resolveProjectId(program.opts().project);
        // Read stdin
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
        // Merge with existing
        const existing = await api.get(`/api/projects/${projectId}/secrets`);
        const existingMap = new Map(existing.map((s) => [s.key, s.value]));
        for (const [k, v] of Object.entries(newSecrets)) {
            existingMap.set(k, v);
        }
        const merged = Array.from(existingMap.entries()).map(([key, value]) => ({
            key,
            value,
        }));
        await api.put(`/api/projects/${projectId}/secrets`, merged);
        if (isJSONMode()) {
            printJSON({ imported: Object.keys(newSecrets) });
        }
        else {
            success(`${Object.keys(newSecrets).length} secret(s) imported`);
        }
    });
}
//# sourceMappingURL=secrets.js.map