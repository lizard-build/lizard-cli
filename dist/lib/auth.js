import open from "open";
import chalk from "chalk";
import { loadConfig, saveConfig, } from "./config.js";
/** Get the active token in priority order: env → file */
export function getToken() {
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
export function loadPendingAuth() {
    return loadConfig().pendingAuth ?? null;
}
export function savePendingAuth(pending) {
    const config = loadConfig();
    config.pendingAuth = pending;
    saveConfig(config);
}
export function clearPendingAuth() {
    const config = loadConfig();
    delete config.pendingAuth;
    saveConfig(config);
}
export function isLoggedIn() {
    return getToken() !== null;
}
function isTTY() {
    return Boolean(process.stdout.isTTY);
}
/**
 * Expiry of a JWT in epoch-ms, decoded from the `exp` claim. Returns null
 * for opaque/undecodable tokens — those are treated as valid and left for
 * the server to reject.
 */
export function jwtExpiryMs(token) {
    try {
        const payload = token.split(".")[1];
        if (!payload)
            return null;
        const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
        return typeof decoded.exp === "number" ? decoded.exp * 1000 : null;
    }
    catch {
        return null;
    }
}
function isExpired(creds) {
    const expMs = jwtExpiryMs(creds.accessToken) ??
        (creds.expiresAt ? Date.parse(creds.expiresAt) : null);
    if (expMs === null || Number.isNaN(expMs))
        return false;
    return Date.now() > expMs - 60_000; // 60s margin
}
/**
 * Ensure the user is authenticated.
 *
 * On first call with no credentials: creates a CLI auth session, saves it to
 * disk, opens the browser, prints the URL, and exits. The user authenticates
 * in the browser, then re-runs their command.
 *
 * On subsequent calls while a session is pending: checks once (no loop) if
 * the user has completed authentication. If yes, stores credentials and
 * returns them. If still pending, prints the URL and exits. If the session
 * expired, starts a fresh one.
 */
export async function requireAuth() {
    if (process.env.LIZARD_TOKEN) {
        return { accessToken: process.env.LIZARD_TOKEN, userId: "", username: "" };
    }
    const creds = loadCredentials();
    if (creds && !isExpired(creds))
        return creds;
    if (!isTTY()) {
        const err = new Error(creds
            ? "Session expired. Run `lizard login` again or set LIZARD_TOKEN."
            : "Not authenticated. Set LIZARD_TOKEN or run `lizard login` first.");
        err.code = "NOT_AUTHENTICATED";
        throw err;
    }
    // Check if we already have a pending auth session
    const pending = loadPendingAuth();
    if (pending) {
        const { checkSession } = await import("../commands/login.js");
        try {
            const result = await checkSession(pending.sessionId, pending.sessionSecret);
            if (result.status === "complete" && result.accessToken && result.user) {
                const expMs = jwtExpiryMs(result.accessToken);
                saveCredentials({
                    accessToken: result.accessToken,
                    expiresAt: expMs ? new Date(expMs).toISOString() : undefined,
                    userId: result.user.id,
                    username: result.user.username,
                    email: result.user.email,
                    avatarUrl: result.user.avatarUrl,
                });
                clearPendingAuth();
                return loadCredentials();
            }
            if (result.status === "expired") {
                clearPendingAuth();
                // Fall through to start a fresh session below
            }
            else {
                // Still pending — user hasn't authenticated yet
                printAuthPrompt(pending.authUrl);
                process.exit(0);
            }
        }
        catch {
            // Network error — assume still pending, show URL
            printAuthPrompt(pending.authUrl);
            process.exit(0);
        }
    }
    // No credentials and no pending session — start a new auth flow
    const { createSession } = await import("../commands/login.js");
    const { getBaseURL } = await import("./api.js");
    const session = await createSession();
    const authUrl = `${getBaseURL()}/auth/cli?session=${session.sessionId}`;
    savePendingAuth({
        sessionId: session.sessionId,
        sessionSecret: session.sessionSecret,
        authUrl,
        createdAt: Date.now(),
    });
    await openURL(authUrl);
    printAuthPrompt(authUrl);
    process.exit(0);
}
function printAuthPrompt(authUrl) {
    process.stderr.write(`\nAuthenticate with Lizard:\n  ${chalk.cyan(authUrl)}\n\nThen run your command again.\n\n`);
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