import chalk from "chalk";
import ora from "ora";
import { saveCredentials, openURL, } from "../lib/auth.js";
import { getBaseURL } from "../lib/api.js";
import { success, info, isJSONMode, printJSON } from "../lib/format.js";
const POLL_INTERVAL = 2000;
const SESSION_TIMEOUT = 300_000; // 5 min
/** Create a CLI login session on the server */
async function createSession() {
    const res = await fetch(`${getBaseURL()}/api/auth/cli/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
    });
    if (!res.ok) {
        throw new Error(`Failed to create login session: ${res.statusText}`);
    }
    return res.json();
}
/** Poll the server to check if the user completed login */
async function pollSession(sessionId, sessionSecret) {
    const res = await fetch(`${getBaseURL()}/api/auth/cli/poll`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, sessionSecret }),
    });
    if (!res.ok) {
        throw new Error(`Poll failed: ${res.statusText}`);
    }
    return res.json();
}
/**
 * Perform the login flow. Used by the login command and by auto-login in requireAuth.
 */
export async function performLogin() {
    // 1. Create session
    const session = await createSession();
    const loginURL = `${getBaseURL()}/auth/cli?session=${session.sessionId}`;
    // 2. Try to open browser
    const opened = await openURL(loginURL);
    if (opened) {
        info("Opening browser to log in...");
    }
    else {
        info(`Open this URL in your browser to log in:\n  ${chalk.cyan(loginURL)}`);
    }
    // 3. Poll until complete
    const spinner = ora("Waiting for login...").start();
    const deadline = Date.now() + SESSION_TIMEOUT;
    while (Date.now() < deadline) {
        await sleep(POLL_INTERVAL);
        try {
            const result = await pollSession(session.sessionId, session.sessionSecret);
            if (result.status === "complete" && result.accessToken && result.user) {
                spinner.stop();
                const creds = {
                    accessToken: result.accessToken,
                    refreshToken: result.refreshToken,
                    userId: result.user.id,
                    username: result.user.username,
                    email: result.user.email,
                    avatarUrl: result.user.avatarUrl,
                };
                saveCredentials(creds);
                if (isJSONMode()) {
                    printJSON({ username: creds.username, email: creds.email });
                }
                else {
                    success(`Logged in as ${chalk.bold(creds.username)}`);
                }
                return creds;
            }
            if (result.status === "expired") {
                spinner.stop();
                throw new Error("Login session expired. Please try again.");
            }
        }
        catch (err) {
            if (err.message?.includes("expired")) {
                spinner.stop();
                throw err;
            }
            // Network error — keep trying
        }
    }
    spinner.stop();
    throw new Error("Login timed out. Please try again.");
}
function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
export function registerLogin(program) {
    program
        .command("login")
        .description("Log in to Lizard")
        .option("--token <token>", "Authenticate with an API token")
        .action(async (opts) => {
        if (opts.token) {
            // Direct token auth — validate it
            const res = await fetch(`${getBaseURL()}/api/auth/me`, {
                headers: { Authorization: `Bearer ${opts.token}` },
            });
            if (!res.ok)
                throw new Error("Invalid token");
            const user = (await res.json());
            saveCredentials({
                accessToken: opts.token,
                userId: user.id,
                username: user.username,
                email: user.email,
                avatarUrl: user.avatarUrl,
            });
            if (isJSONMode()) {
                printJSON({ username: user.username });
            }
            else {
                success(`Logged in as ${chalk.bold(user.username)}`);
            }
            return;
        }
        await performLogin();
    });
}
//# sourceMappingURL=login.js.map