import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const CONFIG_DIR = path.join(os.homedir(), ".lizard");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

export interface Credentials {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  userId: string;
  username: string;
  email?: string;
  avatarUrl?: string;
}

export interface ProjectLink {
  projectId: string;
  projectName?: string;
  appId?: string;
  appName?: string;
}

export interface Config {
  credentials?: Credentials;
  projects?: Record<string, ProjectLink>;
}

export function loadConfig(): Config {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8")) as Config;
  } catch {
    return {};
  }
}

export function saveConfig(config: Config) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), {
    mode: 0o600,
  });
}

export function getProjectLink(cwd: string = process.cwd()): ProjectLink | null {
  return loadConfig().projects?.[cwd] ?? null;
}

export function setProjectLink(link: ProjectLink, cwd: string = process.cwd()) {
  const config = loadConfig();
  config.projects ??= {};
  config.projects[cwd] = link;
  saveConfig(config);
}

export function updateProjectLink(
  patch: Partial<ProjectLink>,
  cwd: string = process.cwd(),
) {
  const existing = getProjectLink(cwd);
  if (!existing) return;
  setProjectLink({ ...existing, ...patch }, cwd);
}

/**
 * Resolve projectId from: --project flag (ID only) → linked cwd → error.
 * For name-based resolution, callers should look up the project list first.
 */
export function resolveProjectId(flagValue?: string): string {
  if (flagValue) return flagValue;
  const link = getProjectLink();
  if (link?.projectId) return link.projectId;
  throw new Error(
    "No project linked. Run `lizard init` or pass --project <id>.",
  );
}
