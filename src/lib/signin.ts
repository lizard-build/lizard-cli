import chalk from "chalk";
import * as p from "@clack/prompts";
import { api, APIError, clientHeaders, getBaseURL } from "./api.js";
import {
  clearCredentials,
  clearPendingAuth,
  envToken,
  loadPendingAuth,
  openURL,
  savePendingAuth,
  saveSessionLogin,
  validToken,
} from "./auth.js";

// Browser sign-in, shared by `lizard login` and the auth gate every other
// command passes (requireAuth).
//
// A person at a terminal picks GitHub or Google, the browser opens at that
// provider, and the CLI waits for the approval, then carries on. A coding
// agent (no terminal, or --json) gets the links and an instruction instead:
// no browser, no waiting. The session stays on disk, and the next run picks
// it up once the user has approved it.

/** The sign-in methods the /auth/cli page can send a person to. */
export type AuthProvider = "github" | "google";
export const AUTH_PROVIDERS: AuthProvider[] = ["github", "google"];
const PROVIDER_LABEL: Record<AuthProvider, string> = { github: "GitHub", google: "Google" };

/** How long the platform keeps a CLI session, for sessions saved without `expiresAt`. */
const SESSION_TTL_MS = 300_000;
/** The platform allows 60 polls per session over its 5 minutes: one every 5 s. */
const POLL_MS = 5_000;

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

export interface Me {
  id: string;
  username: string;
  email?: string | null;
  scoped?: boolean;
}

export interface Pending {
  sessionId: string;
  sessionSecret: string;
  expiresAt: number;
}

export type Resumed =
  | { kind: "none" }
  | { kind: "complete" }
  | { kind: "pending"; pending: Pending }
  | { kind: "expired" };

/**
 * The page that approves a CLI session. With a provider it signs a signed-out
 * browser in with that method; without one it uses GitHub, as it always has.
 */
export function authUrlFor(sessionId: string, provider?: AuthProvider): string {
  const url = `${getBaseURL()}/auth/cli?session=${sessionId}`;
  return provider ? `${url}&provider=${provider}` : url;
}

/** Which sign-in methods the platform offers. Both, if it cannot be asked. */
export async function fetchAuthProviders(): Promise<AuthProvider[]> {
  try {
    const res = await fetch(`${getBaseURL()}/api/auth/providers`, { headers: clientHeaders() });
    if (!res.ok) return AUTH_PROVIDERS;
    const body = (await res.json()) as Partial<Record<AuthProvider, boolean>>;
    const on = AUTH_PROVIDERS.filter((m) => body[m]);
    return on.length ? on : AUTH_PROVIDERS;
  } catch {
    return AUTH_PROVIDERS;
  }
}

/** `--github` / `--google`, or undefined when neither is given. */
export function providerFlag(opts: { github?: boolean; google?: boolean }): AuthProvider | undefined {
  if (opts.github && opts.google) throw new Error("Pass --github or --google, not both.");
  return opts.google ? "google" : opts.github ? "github" : undefined;
}

/** Create a CLI login session on the server */
export async function createSession(): Promise<SessionResponse> {
  const res = await fetch(`${getBaseURL()}/api/auth/cli/session`, {
    method: "POST",
    headers: { ...clientHeaders(), "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(`Failed to create login session: ${res.statusText}`);
  return res.json() as Promise<SessionResponse>;
}

/** Check once if the user has completed authentication (no polling loop) */
export async function checkSession(sessionId: string, sessionSecret: string): Promise<CheckResponse> {
  const res = await fetch(`${getBaseURL()}/api/auth/cli/poll`, {
    method: "POST",
    // The platform records the login from this request; its User-Agent is
    // what files it under the CLI and the agent running it.
    headers: { ...clientHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, sessionSecret }),
  });
  if (!res.ok) throw new Error(`Auth check failed: ${res.statusText}`);
  return res.json() as Promise<CheckResponse>;
}

/** The signed-in user, or null when this machine needs a sign-in. */
export async function currentUser(): Promise<Me | null> {
  if (!validToken()) return null;
  try {
    return await api.get<Me>("/api/auth/me");
  } catch (err) {
    // A saved token the platform no longer accepts is as good as none. A token
    // from the environment is the caller's to fix, so that error stands.
    if (err instanceof APIError && err.status === 401 && !envToken()) {
      clearCredentials();
      return null;
    }
    throw err;
  }
}

/** Finish a session an earlier run left on disk, if the browser approved it. */
export async function resumePending(): Promise<Resumed> {
  const saved = loadPendingAuth();
  if (!saved) return { kind: "none" };
  const pending: Pending = {
    sessionId: saved.sessionId,
    sessionSecret: saved.sessionSecret,
    expiresAt: saved.expiresAt ?? saved.createdAt + SESSION_TTL_MS,
  };
  let result: CheckResponse;
  try {
    result = await checkSession(pending.sessionId, pending.sessionSecret);
  } catch {
    // A dropped request or the poll limit says nothing about the session.
    if (Date.now() < pending.expiresAt) return { kind: "pending", pending };
    clearPendingAuth();
    return { kind: "expired" };
  }
  if (result.status === "complete" && result.accessToken && result.user) {
    saveSessionLogin({ accessToken: result.accessToken, user: result.user });
    return { kind: "complete" };
  }
  if (result.status === "expired") {
    clearPendingAuth();
    return { kind: "expired" };
  }
  return { kind: "pending", pending };
}

export async function startSession(provider?: AuthProvider): Promise<Pending> {
  const session = await createSession();
  const now = Date.now();
  const pending: Pending = {
    sessionId: session.sessionId,
    sessionSecret: session.sessionSecret,
    expiresAt: now + session.expiresIn * 1000,
  };
  savePendingAuth({ ...pending, authUrl: authUrlFor(session.sessionId, provider), createdAt: now });
  return pending;
}

/** Poll until the browser approves the session. Null if it expires first. */
async function waitForApproval(pending: Pending): Promise<CheckResponse | null> {
  while (Date.now() < pending.expiresAt) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    try {
      const result = await checkSession(pending.sessionId, pending.sessionSecret);
      if (result.status === "complete") return result;
      if (result.status === "expired") return null;
    } catch {
      // A dropped request or the poll limit: try again on the next tick.
    }
  }
  return null;
}

// ── For agents ──────────────────────────────────────────────────────────

/**
 * What an agent needs to get the user signed in: the links and what to do
 * with them. `status` and `authUrl` are what `lizard login --json` has always
 * printed; `authUrl` without a chosen method is the old link, which opens
 * GitHub.
 */
export function pendingPayload(
  pending: Pending,
  methods: AuthProvider[],
  why: "new" | "waiting" | "expired",
  opts: { flag?: AuthProvider; nextCommand?: string } = {},
  now = Date.now(),
) {
  const authUrls = Object.fromEntries(methods.map((m) => [m, authUrlFor(pending.sessionId, m)])) as Partial<
    Record<AuthProvider, string>
  >;
  const single = methods.length === 1 ? methods[0] : undefined;
  const minutes = Math.max(1, Math.round((pending.expiresAt - now) / 60_000));
  const window = minutes === 1 ? "1 more minute" : `${minutes} more minutes`;
  const then = opts.nextCommand ? "run nextCommand" : "run the same command again";
  const lead =
    why === "waiting"
      ? "The user has not finished signing in yet. "
      : why === "expired"
        ? "The last sign-in link expired; this is a new one. "
        : "";
  const instruction = single
    ? `${lead}Sign-in is needed. Give the user authUrl to open. Once the browser says "CLI authorized", ${then}. ` +
      `The link works for ${window}; after that a new one is printed.`
    : `${lead}Sign-in is needed. Ask the user how they sign in to Lizard and give them that link from authUrls. ` +
      "Someone who already has an account must use the same method as before: another method opens a second, empty account " +
      "unless both share a verified email. A new user can pick either. " +
      `Once the browser says "CLI authorized", ${then}. The links work for ${window}; after that new ones are printed.`;
  return {
    status: "pending" as const,
    authUrl: single ? authUrls[single]! : authUrlFor(pending.sessionId, opts.flag),
    authUrls,
    expiresAt: new Date(pending.expiresAt).toISOString(),
    ...(opts.nextCommand ? { nextCommand: opts.nextCommand } : {}),
    instruction,
  };
}

/**
 * The error a command fails with when nobody is signed in and nobody can be
 * asked. Its body carries the sign-in links, so an agent can hand them to the
 * user and run the command again, without a separate `lizard login`.
 */
export async function loginRequiredError(resumed: Resumed, hadLogin: boolean): Promise<APIError> {
  const base = hadLogin ? "The Lizard sign-in on this machine expired." : "Not signed in to Lizard.";
  const plain = new APIError(
    401,
    `${base} Run \`lizard login\`, or set LIZARD_TOKEN (or LIZARD_API_KEY).`,
    "NOT_AUTHENTICATED",
  );
  // CI has nobody to open a link: say what to set and stop there.
  if (process.env.CI) return plain;
  try {
    const pending = resumed.kind === "pending" ? resumed.pending : await startSession();
    const why = resumed.kind === "pending" ? "waiting" : resumed.kind === "expired" ? "expired" : "new";
    const login = pendingPayload(pending, await fetchAuthProviders(), why);
    return new APIError(401, `${base} ${login.instruction}`, "NOT_AUTHENTICATED", { login });
  } catch {
    return plain;
  }
}

// ── For people ──────────────────────────────────────────────────────────

function cancelled(): never {
  p.cancel("Cancelled.");
  process.exit(5);
}

async function askProvider(): Promise<AuthProvider> {
  const methods = await fetchAuthProviders();
  if (methods.length === 1) return methods[0];
  p.log.message(chalk.dim("Already have an account? Pick the method you signed up with."));
  const choice = await p.select({
    message: "How do you sign in to Lizard?",
    options: methods.map((m) => ({ value: m, label: PROVIDER_LABEL[m] })),
  });
  if (p.isCancel(choice)) cancelled();
  return choice as AuthProvider;
}

/**
 * Sign in at a terminal: ask the method (when stdin can answer), open the
 * browser there, wait for the approval, save the login. Throws if the link
 * expires first.
 */
export async function signInInteractive(flag?: AuthProvider): Promise<Me> {
  const provider = flag ?? (process.stdin.isTTY ? await askProvider() : undefined);
  const pending = await startSession(provider);
  if (provider) {
    const url = authUrlFor(pending.sessionId, provider);
    const opened = await openURL(url);
    p.log.info(`${opened ? "Opened your browser. If it did not open, use this link" : "Open this link to sign in"}:\n${chalk.cyan(url)}`);
  } else {
    const methods = await fetchAuthProviders();
    p.log.info(
      ["Open one of these links to sign in:", ...methods.map((m) => `${PROVIDER_LABEL[m]}: ${chalk.cyan(authUrlFor(pending.sessionId, m))}`)].join("\n"),
    );
  }

  // Ctrl+C at a terminal never reaches onCancel: clack holds stdin raw while it
  // spins and exits on the keypress itself, printing cancelMessage on the way
  // out. So the message carries the hint, and the session stays on disk for
  // whichever lizard command runs next.
  const spin = p.spinner({
    cancelMessage: "Stopped waiting. The link works for a few more minutes: finish in the browser, then run the command again",
    onCancel: () => process.exit(5),
  });
  spin.start("Waiting for you to authorize Lizard CLI in the browser");
  const result = await waitForApproval(pending);
  if (!result?.accessToken || !result.user) {
    spin.error("The sign-in link expired");
    clearPendingAuth();
    throw new Error("The sign-in link expired. Run the command again for a new one.");
  }
  saveSessionLogin({ accessToken: result.accessToken, user: result.user });
  spin.stop("Authorized");
  const me = await api.get<Me>("/api/auth/me");
  p.log.success(`Signed in as ${chalk.bold(me.username)}`);
  return me;
}
