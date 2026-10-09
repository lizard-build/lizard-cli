import chalk from "chalk";
import { saveCredentials, savePendingAuth, openURL, jwtExpiryMs, } from "../lib/auth.js";
import { getBaseURL, clientHeaders } from "../lib/api.js";
import { success, isJSONMode, printJSON } from "../lib/format.js";
export const AUTH_PROVIDERS = ["github", "google"];
/**
 * The page that approves a CLI session. With a provider it signs a signed-out
 * browser in with that method; without one it uses GitHub, as it always has.
 */
export function authUrlFor(sessionId, provider) {
    const url = `${getBaseURL()}/auth/cli?session=${sessionId}`;
    return provider ? `${url}&provider=${provider}` : url;
}
/** Which sign-in methods the platform offers. Both, if it cannot be asked. */
export async function fetchAuthProviders() {
    try {
        const res = await fetch(`${getBaseURL()}/api/auth/providers`, { headers: clientHeaders() });
        if (!res.ok)
            return AUTH_PROVIDERS;
        const body = (await res.json());
        const on = AUTH_PROVIDERS.filter((p) => body[p]);
        return on.length ? on : AUTH_PROVIDERS;
    }
    catch {
        return AUTH_PROVIDERS;
    }
}
/** `--github` / `--google`, or undefined when neither is given. */
export function providerFlag(opts) {
    if (opts.github && opts.google)
        throw new Error("Pass --github or --google, not both.");
    return opts.google ? "google" : opts.github ? "github" : undefined;
}
/** Create a CLI login session on the server */
export async function createSession() {
    const res = await fetch(`${getBaseURL()}/api/auth/cli/session`, {
        method: "POST",
        headers: { ...clientHeaders(), "Content-Type": "application/json" },
    });
    if (!res.ok)
        throw new Error(`Failed to create login session: ${res.statusText}`);
    return res.json();
}
/** Check once if the user has completed authentication (no polling loop) */
export async function checkSession(sessionId, sessionSecret) {
    const res = await fetch(`${getBaseURL()}/api/auth/cli/poll`, {
        method: "POST",
        // The platform records the login from this request; its User-Agent is
        // what files it under the CLI and the agent running it.
        headers: { ...clientHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, sessionSecret }),
    });
    if (!res.ok)
        throw new Error(`Auth check failed: ${res.statusText}`);
    return res.json();
}
/**
 * Start the login flow: creates a session, saves it to disk, surfaces the
 * auth URL, then exits. In human mode it opens the browser and prints the
 * URL; in JSON mode it emits the URL as JSON and never opens a browser. The
 * user authenticates and re-runs their original command — requireAuth will
 * pick up the pending session.
 */
export async function performLogin(provider) {
    const session = await createSession();
    const authUrl = authUrlFor(session.sessionId, provider);
    savePendingAuth({
        sessionId: session.sessionId,
        sessionSecret: session.sessionSecret,
        authUrl,
        createdAt: Date.now(),
        expiresAt: Date.now() + session.expiresIn * 1000,
    });
    // In JSON mode emit the URL as machine-readable output and never spawn a
    // browser — agents drive this flow and popping open a browser on a
    // headless/agent host is wrong. In human mode, open it and print the URL.
    if (isJSONMode()) {
        printJSON({ status: "pending", authUrl });
    }
    else {
        await openURL(authUrl);
        process.stderr.write(`\nAuthenticate with Lizard:\n  ${chalk.cyan(authUrl)}\n\nOnce authenticated, run your command again.\n\n`);
    }
    process.exit(0);
}
export function registerLogin(program) {
    program
        .command("login")
        .description("Log in to Lizard")
        .option("--token <token>", "Authenticate with an API token")
        .option("--github", "Sign in with GitHub")
        .option("--google", "Sign in with Google")
        .action(async (opts) => {
        const provider = providerFlag(opts);
        const token = opts.token;
        if (token) {
            // Direct token auth — validate it
            const res = await fetch(`${getBaseURL()}/api/auth/me`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            if (!res.ok)
                throw new Error("Invalid token");
            const user = (await res.json());
            const expMs = jwtExpiryMs(token);
            saveCredentials({
                accessToken: token,
                expiresAt: expMs ? new Date(expMs).toISOString() : undefined,
                userId: user.id,
                username: user.username,
                email: user.email,
                avatarUrl: user.avatarUrl,
            });
            if (isJSONMode()) {
                printJSON({ status: "complete", username: user.username });
            }
            else {
                success(`Logged in as ${chalk.bold(user.username)}`);
            }
            return;
        }
        await performLogin(provider);
    });
}
//# sourceMappingURL=login.js.map