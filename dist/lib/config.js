import fs from "node:fs";
import path from "node:path";
import os from "node:os";
const CONFIG_DIR = path.join(os.homedir(), ".lizard");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
export function loadConfig() {
    try {
        return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
    }
    catch {
        return {};
    }
}
export function saveConfig(config) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), {
        mode: 0o600,
    });
}
export function getProjectLink(cwd = process.cwd()) {
    return loadConfig().projects?.[cwd] ?? null;
}
export function setProjectLink(link, cwd = process.cwd()) {
    const config = loadConfig();
    config.projects ??= {};
    config.projects[cwd] = link;
    saveConfig(config);
}
export function updateProjectLink(patch, cwd = process.cwd()) {
    const existing = getProjectLink(cwd);
    if (!existing)
        return;
    setProjectLink({ ...existing, ...patch }, cwd);
}
/**
 * Resolve projectId from: --project flag (ID only) → linked cwd → error.
 * For name-based resolution, callers should look up the project list first.
 */
export function resolveProjectId(flagValue) {
    if (flagValue)
        return flagValue;
    const link = getProjectLink();
    if (link?.projectId)
        return link.projectId;
    throw new Error("No project linked. Run `lizard init` or pass --project <id>.");
}
//# sourceMappingURL=config.js.map