import open from "open";
import {
  loadConfig,
  saveConfig,
  type Credentials,
} from "./config.js";

export type { Credentials } from "./config.js";

/** Get the active token in priority order: env → file */
export function getToken(): string | null {
  if (process.env.LIZARD_TOKEN) return process.env.LIZARD_TOKEN;
  return loadCredentials()?.accessToken ?? null;
}

export function loadCredentials(): Credentials | null {
  return loadConfig().credentials ?? null;
}

export function saveCredentials(creds: Credentials) {
  const config = loadConfig();
  config.credentials = creds;
  saveConfig(config);
}

export function clearCredentials() {
  const config = loadConfig();
  delete config.credentials;
  saveConfig(config);
}

export function isLoggedIn(): boolean {
  return getToken() !== null;
}

function isTTY(): boolean {
  return Boolean(process.stdout.isTTY);
}

/**
 * Expiry of a JWT in epoch-ms, decoded from the `exp` claim. Returns null
 * for opaque/undecodable tokens — those are treated as valid and left for
 * the server to reject.
 */
export function jwtExpiryMs(token: string): number | null {
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return typeof decoded.exp === "number" ? decoded.exp * 1000 : null;
  } catch {
    return null;
  }
}

function isExpired(creds: Credentials): boolean {
  const expMs =
    jwtExpiryMs(creds.accessToken) ??
    (creds.expiresAt ? Date.parse(creds.expiresAt) : null);
  if (expMs === null || Number.isNaN(expMs)) return false;
  return Date.now() > expMs - 60_000; // 60s margin
}

/**
 * Ensure the user is authenticated. If not logged in (or the saved token
 * has expired — there is no refresh endpoint) and TTY, auto-login.
 * Returns credentials or throws.
 */
export async function requireAuth(): Promise<Credentials> {
  if (process.env.LIZARD_TOKEN) {
    return {
      accessToken: process.env.LIZARD_TOKEN,
      userId: "",
      username: "",
    };
  }

  const creds = loadCredentials();
  if (creds && !isExpired(creds)) return creds;

  if (!isTTY()) {
    const err = new Error(
      creds
        ? "Session expired. Run `lizard login` again or set LIZARD_TOKEN."
        : "Not authenticated. Set LIZARD_TOKEN or run `lizard login` first.",
    ) as Error & { code: string };
    err.code = "NOT_AUTHENTICATED";
    throw err;
  }

  if (creds) {
    process.stderr.write("Session expired — logging in again...\n");
  }
  const { performLogin } = await import("../commands/login.js");
  return performLogin();
}

/** Open a URL in the default browser, or print it if headless. */
export async function openURL(url: string) {
  const isSSH = Boolean(
    process.env.SSH_CLIENT || process.env.SSH_TTY || process.env.SSH_CONNECTION,
  );
  const isCI = Boolean(process.env.CI);
  const noDisplay =
    process.platform === "linux" &&
    !process.env.DISPLAY &&
    !process.env.WAYLAND_DISPLAY;

  if (isSSH || isCI || noDisplay) {
    return false;
  }

  try {
    await open(url);
    return true;
  } catch {
    return false;
  }
}
