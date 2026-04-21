import fs from "node:fs";
import path from "node:path";
import os from "node:os";
const CONFIG_DIR = ".lizard";
const CONFIG_FILE = "config.json";
const GLOBAL_SETTINGS_FILE = path.join(os.homedir(), ".lizard", "settings.json");
/** Find project config by walking up from cwd */
export function findProjectConfig() {
    let dir = process.cwd();
    while (true) {
        const configPath = path.join(dir, CONFIG_DIR, CONFIG_FILE);
        if (fs.existsSync(configPath)) {
            try {
                return JSON.parse(fs.readFileSync(configPath, "utf-8"));
            }
            catch {
                return null;
            }
        }
        const parent = path.dirname(dir);
        if (parent === dir)
            break;
        dir = parent;
    }
    return null;
}
/** Save project config in cwd */
export function saveProjectConfig(config) {
    const dir = path.join(process.cwd(), CONFIG_DIR);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, CONFIG_FILE), JSON.stringify(config, null, 2));
    // Add .lizard/ to .gitignore if not already there
    const gitignorePath = path.join(process.cwd(), ".gitignore");
    try {
        const existing = fs.existsSync(gitignorePath)
            ? fs.readFileSync(gitignorePath, "utf-8")
            : "";
        if (!existing.includes(".lizard/")) {
            fs.appendFileSync(gitignorePath, (existing.endsWith("\n") ? "" : "\n") + ".lizard/\n");
        }
    }
    catch { }
}
export function loadGlobalSettings() {
    try {
        return JSON.parse(fs.readFileSync(GLOBAL_SETTINGS_FILE, "utf-8"));
    }
    catch {
        return {};
    }
}
export function saveGlobalSettings(settings) {
    const dir = path.dirname(GLOBAL_SETTINGS_FILE);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(GLOBAL_SETTINGS_FILE, JSON.stringify(settings, null, 2));
}
/**
 * Resolve projectId from: --project flag → .lizard/config.json → error
 */
export function resolveProjectId(flagValue) {
    if (flagValue)
        return flagValue;
    const config = findProjectConfig();
    if (config?.projectId)
        return config.projectId;
    throw new Error("No project linked. Run `lizard init` or `lizard link` first, or use --project <id>.");
}
/**
 * Resolve environment from: --environment flag → .lizard/config.json → "production"
 */
export function resolveEnvironment(flagValue) {
    if (flagValue)
        return flagValue;
    const config = findProjectConfig();
    return config?.environment ?? "production";
}
//# sourceMappingURL=config.js.map