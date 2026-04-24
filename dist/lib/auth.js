import open from "open";
import { loadConfig, saveConfig, } from "./config.js";
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
    return loadCredentials()?.accessToken ?? null;
}
export function loadCredentials() {
    return loadConfig().credentials ?? null;
}
export function saveCredentials(creds) {
    const config = loadConfig();
    config.credentials = creds;
    saveConfig(config);
}
export function clearCredentials() {
    const config = loadConfig();
    delete config.credentials;
    saveConfig(config);
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
    if (!isTTY()) {
        throw new Error("Not authenticated. Set LIZARD_TOKEN or run `lizard login` first.");
    }
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
        return false;
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