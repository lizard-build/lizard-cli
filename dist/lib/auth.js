import open from "open";
import { isJSONMode } from "./format.js";
import { loadConfig, saveConfig, } from "./config.js";
/**
 * The env var carrying a token or a `liz_` API key. LIZARD_TOKEN is the
 * original name; LIZARD_API_KEY is what people reach for when what they hold
 * is an API key, and it silently did nothing before — the CLI fell through to
 * the credentials file and reported "Not authenticated" while the key sat
 * right there in the environment. Both names go to the same header.
 */
export function envToken() {
    return process.env.LIZARD_TOKEN || process.env.LIZARD_API_KEY || null;
}
/** Get the active token in priority order: env → file */
export function getToken() {
    return envToken() ?? loadCredentials()?.accessToken ?? null;
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
/** The token a command would use right now, or null when a sign-in is needed. */
export function validToken() {
    const fromEnv = envToken();
    if (fromEnv)
        return fromEnv;
    const creds = loadCredentials();
    return creds && !isExpired(creds) ? creds.accessToken : null;
}
/** Store what an approved CLI session returned, and drop the pending session. */
export function saveSessionLogin(result) {
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
 * A token from the environment or a saved login that has not expired wins.
 * Otherwise a session the browser already approved finishes here. Failing
 * that, a person at a terminal signs in on the spot (pick GitHub or Google,
 * the browser opens, the CLI waits) and the command carries on. Anything else
 * (an agent, a pipe, --json) gets a NOT_AUTHENTICATED error whose body holds
 * the sign-in links; once the user approves, the same command run again
 * picks the session up.
 */
export async function requireAuth() {
    const fromEnv = envToken();
    if (fromEnv) {
        return { accessToken: fromEnv, userId: "", username: "" };
    }
    const creds = loadCredentials();
    if (creds && !isExpired(creds))
        return creds;
    const signin = await import("./signin.js");
    const resumed = await signin.resumePending();
    if (resumed.kind === "complete")
        return loadCredentials();
    if (isTTY() && !isJSONMode()) {
        await signin.signInInteractive();
        return loadCredentials();
    }
    throw await signin.loginRequiredError(resumed, Boolean(creds));
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