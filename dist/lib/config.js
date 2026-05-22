import fs from "node:fs";
import path from "node:path";
import os from "node:os";
export const DEFAULT_REGION = "us-east-1";
// Resolve at every call so tests (and exotic shells that mutate HOME) get a
// fresh path. Cost is negligible — we hit disk anyway. LIZARD_HOME lets tests
// (and power users) point the config dir somewhere other than ~/.lizard.
function configDir() {
    return process.env.LIZARD_HOME
        ? path.join(process.env.LIZARD_HOME, ".lizard")
        : path.join(os.homedir(), ".lizard");
}
function configFile() {
    return path.join(configDir(), "config.json");
}
export function loadConfig() {
    try {
        return JSON.parse(fs.readFileSync(configFile(), "utf-8"));
    }
    catch {
        return {};
    }
}
export function saveConfig(config) {
    fs.mkdirSync(configDir(), { recursive: true });
    fs.writeFileSync(configFile(), JSON.stringify(config, null, 2), {
        mode: 0o600,
    });
}
/**
 * Read the link for a directory. Normalises legacy `appId/appName` into
 * `serviceId/serviceName` so callers only have to look at one pair.
 */
export function getProjectLink(cwd = process.cwd()) {
    const raw = loadConfig().projects?.[cwd];
    if (!raw)
        return null;
    return {
        ...raw,
        serviceId: raw.serviceId ?? raw.appId,
        serviceName: raw.serviceName ?? raw.appName,
    };
}
export function setProjectLink(link, cwd = process.cwd()) {
    const config = loadConfig();
    config.projects ??= {};
    // Mirror service↔app for older readers.
    const normalised = {
        ...link,
        appId: link.serviceId ?? link.appId,
        appName: link.serviceName ?? link.appName,
        serviceId: link.serviceId ?? link.appId,
        serviceName: link.serviceName ?? link.appName,
    };
    config.projects[cwd] = normalised;
    saveConfig(config);
}
export function updateProjectLink(patch, cwd = process.cwd()) {
    const existing = getProjectLink(cwd);
    if (!existing)
        return;
    setProjectLink({ ...existing, ...patch }, cwd);
}
export function clearProjectLink(cwd = process.cwd()) {
    const config = loadConfig();
    if (config.projects) {
        delete config.projects[cwd];
        saveConfig(config);
    }
}
/**
 * Resolve a project flag (name, slug, or ID) to an actual project ID.
 * When no flag is given, falls back to the linked cwd. Hits the API only
 * when a flag is provided so name/slug lookups work as advertised.
 */
export async function resolveProjectId(flagValue) {
    if (!flagValue) {
        const link = getProjectLink();
        if (link?.projectId)
            return link.projectId;
        throw new Error("No project linked. Run `lizard init` or pass --project <id>.");
    }
    const { api } = await import("./api.js");
    const projects = await api.get("/api/projects");
    const match = projects.find((p) => p.id === flagValue || p.slug === flagValue || p.name === flagValue);
    if (!match)
        throw new Error(`Project "${flagValue}" not found.`);
    return match.id;
}
//# sourceMappingURL=config.js.map