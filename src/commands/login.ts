import chalk from "chalk";
import { Command } from "commander";
import {
  saveCredentials,
  savePendingAuth,
  openURL,
  jwtExpiryMs,
  type Credentials,
} from "../lib/auth.js";
import { getBaseURL } from "../lib/api.js";
import { success, isJSONMode, printJSON } from "../lib/format.js";

interface SessionResponse {
  sessionId: string;
  sessionSecret: string;
  expiresIn: number;
}

export interface CheckResponse {
  status: "pending" | "complete" | "expired";
  accessToken?: string;
  user?: {
    id: string;
    username: string;
    email?: string;
    avatarUrl?: string;
  };
}

/** Create a CLI login session on the server */
export async function createSession(): Promise<SessionResponse> {
  const res = await fetch(`${getBaseURL()}/api/auth/cli/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(`Failed to create login session: ${res.statusText}`);
  return res.json() as Promise<SessionResponse>;
}

/** Check once if the user has completed authentication (no polling loop) */
export async function checkSession(
  sessionId: string,
  sessionSecret: string,
): Promise<CheckResponse> {
  const res = await fetch(`${getBaseURL()}/api/auth/cli/poll`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, sessionSecret }),
  });
  if (!res.ok) throw new Error(`Auth check failed: ${res.statusText}`);
  return res.json() as Promise<CheckResponse>;
}

/**
 * Start the login flow: creates a session, saves it to disk, surfaces the
 * auth URL, then exits. In human mode it opens the browser and prints the
 * URL; in JSON mode it emits the URL as JSON and never opens a browser. The
 * user authenticates and re-runs their original command — requireAuth will
 * pick up the pending session.
 */
export async function performLogin(): Promise<never> {
  const session = await createSession();
  const authUrl = `${getBaseURL()}/auth/cli?session=${session.sessionId}`;

  savePendingAuth({
    sessionId: session.sessionId,
    sessionSecret: session.sessionSecret,
    authUrl,
    createdAt: Date.now(),
  });

  // In JSON mode emit the URL as machine-readable output and never spawn a
  // browser — agents drive this flow and popping open a browser on a
  // headless/agent host is wrong. In human mode, open it and print the URL.
  if (isJSONMode()) {
    printJSON({ status: "pending", authUrl });
  } else {
    await openURL(authUrl);
    process.stderr.write(
      `\nAuthenticate with Lizard:\n  ${chalk.cyan(authUrl)}\n\nOnce authenticated, run your command again.\n\n`,
    );
  }
  process.exit(0);
}

export function registerLogin(program: Command) {
  program
    .command("login")
    .description("Log in to Lizard")
    .option("--token <token>", "Authenticate with an API token")
    .action(async (opts) => {
      const token = opts.token;
      if (token) {
        // Direct token auth — validate it
        const res = await fetch(`${getBaseURL()}/api/auth/me`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new Error("Invalid token");
        const user = (await res.json()) as any;
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
        } else {
          success(`Logged in as ${chalk.bold(user.username)}`);
        }
        return;
      }

      await performLogin();
    });
}
