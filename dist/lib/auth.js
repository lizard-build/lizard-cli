import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import open from "open";
const LIZARD_DIR = path.join(os.homedir(), ".lizard");
const CREDENTIALS_FILE = path.join(LIZARD_DIR, "credentials.json");
let tokenOverride = null;
export function setTokenOverride(token) {
    tokenOverride = token;
}
/** Get the active token in priority order: override → env → file */
export function getToken() {
    if (tokenOverride)
        return tokenOverride;
    if (process.env.LIZARD_TOKEN)
        return process.env.LIZARD_TOKEN;
    const creds = loadCredentials();
    return creds?.accessToken ?? null;
}
export function loadCredentials() {
    try {
        const data = fs.readFileSync(CREDENTIALS_FILE, "utf-8");
        return JSON.parse(data);
    }
    catch {
        return null;
    }
}
export function saveCredentials(creds) {
    fs.mkdirSync(LIZARD_DIR, { recursive: true });
    fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify(creds, null, 2), {
        mode: 0o600,
    });
}
export function clearCredentials() {
    try {
        fs.unlinkSync(CREDENTIALS_FILE);
    }
    catch { }
}
export function isLoggedIn() {
    return getToken() !== null;
}
function isTTY() {
    return Boolean(process.stdout.isTTY);
}
/**
 * Ensure the user is authenticated. If not logged in and TTY, auto-login.
 * Returns credentials or throws.
 */
export async function requireAuth() {
    // Token override or env var — we don't have full Credentials, fake it
    if (tokenOverride || process.env.LIZARD_TOKEN) {
        return {
            accessToken: (tokenOverride || process.env.LIZARD_TOKEN),
            userId: "",
            username: "",
        };
    }
    const creds = loadCredentials();
    if (creds)
        return creds;
    // Not logged in
    if (!isTTY()) {
        throw new Error("Not authenticated. Set LIZARD_TOKEN or run `lizard login` first.");
    }
    // Auto-login
    const { performLogin } = await import("../commands/login.js");
    return performLogin();
}
/** Open a URL in the default browser, or print it if headless. */
export async function openURL(url) {
    const isSSH = Boolean(process.env.SSH_CLIENT || process.env.SSH_TTY || process.env.SSH_CONNECTION);
    const isCI = Boolean(process.env.CI);
    const noDisplay = process.platform === "linux" &&
        !process.env.DISPLAY &&
        !process.env.WAYLAND_DISPLAY;
    if (isSSH || isCI || noDisplay) {
        return false; // caller should show URL manually
    }
    try {
        await open(url);
        return true;
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=auth.js.map