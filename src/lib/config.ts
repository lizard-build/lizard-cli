import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const CONFIG_DIR = ".lizard";
const CONFIG_FILE = "config.json";
const GLOBAL_SETTINGS_FILE = path.join(os.homedir(), ".lizard", "settings.json");

export interface ProjectConfig {
  workspaceId?: string;
  projectId: string;
  projectName?: string;
  environment?: string;
}

export interface GlobalSettings {
  defaultWorkspace?: string;
  defaultProject?: string;
  defaultProjectName?: string;
}

/** Find project config by walking up from cwd */
export function findProjectConfig(): ProjectConfig | null {
  let dir = process.cwd();
  while (true) {
    const configPath = path.join(dir, CONFIG_DIR, CONFIG_FILE);
    if (fs.existsSync(configPath)) {
      try {
        return JSON.parse(fs.readFileSync(configPath, "utf-8"));
      } catch {
        return null;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Save project config in cwd */
export function saveProjectConfig(config: ProjectConfig) {
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
      fs.appendFileSync(
        gitignorePath,
        (existing.endsWith("\n") ? "" : "\n") + ".lizard/\n",
      );
    }
  } catch {}
}

export function loadGlobalSettings(): GlobalSettings {
  try {
    return JSON.parse(fs.readFileSync(GLOBAL_SETTINGS_FILE, "utf-8"));
  } catch {
    return {};
  }
}

export function saveGlobalSettings(settings: GlobalSettings) {
  const dir = path.dirname(GLOBAL_SETTINGS_FILE);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(GLOBAL_SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

/**
 * Resolve projectId. Priority:
 *   1. --project flag
 *   2. .lizard/config.json (directory link)
 *   3. ~/.lizard/settings.json → defaultProject (unless localOnly)
 *   4. error
 *
 * `localOnly: true` forbids the global fallback — used by destructive commands
 * like `deploy` that act on cwd and must not silently target a different project.
 */
export function resolveProjectId(
  flagValue?: string,
  opts?: { localOnly?: boolean },
): string {
  if (flagValue) return flagValue;
  const config = findProjectConfig();
  if (config?.projectId) return config.projectId;
  if (!opts?.localOnly) {
    const global = loadGlobalSettings();
    if (global.defaultProject) return global.defaultProject;
  }
  if (opts?.localOnly) {
    throw new Error(
      "This command requires a project linked to the current directory. Run `lizard init` or `lizard link`, or pass --project <id>.",
    );
  }
  throw new Error(
    "No project linked. Run `lizard init`, `lizard link`, or `lizard project use <name>`, or pass --project <id>.",
  );
}

/**
 * Resolve environment from: --environment flag → .lizard/config.json → "production"
 */
export function resolveEnvironment(flagValue?: string): string {
  if (flagValue) return flagValue;
  const config = findProjectConfig();
  return config?.environment ?? "production";
}
