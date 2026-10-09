import chalk from "chalk";
import * as p from "@clack/prompts";
import { Command } from "commander";
import { api, APIError } from "../lib/api.js";
import {
  clearCredentials,
  clearPendingAuth,
  envToken,
  loadPendingAuth,
  openURL,
  savePendingAuth,
  saveSessionLogin,
  validToken,
} from "../lib/auth.js";
import { getProjectLink } from "../lib/config.js";
import { isJSONMode } from "../lib/format.js";
import {
  authUrlFor,
  checkSession,
  createSession,
  fetchAuthProviders,
  providerFlag,
  type AuthProvider,
  type CheckResponse,
} from "./login.js";
import { CREDITS_END, billingUrl, daysLeft, describeSubscription, usd, type Subscription } from "./billing.js";

// `lizard onboard` sets a machine up right after install: sign in, then only
// what the account still needs. The installers run it as their last step.
//
// It has two modes, chosen the way every command chooses JSON mode:
//   - A person at a terminal picks a sign-in method, the browser opens, and the
//     command waits for the sign-in. Then it offers a plan if the account has
//     none.
//   - A coding agent (stdout is not a terminal, or --json) gets JSON lines,
//     each carrying an `instruction` that says what to do next and what not to
//     do. It never waits and never opens a browser: it prints the links and
//     exits, and the next run picks up the sign-in.
//
// Safe to re-run. It reuses the session store `lizard login` and requireAuth
// use, so a link from either finishes here, and the other way round.

/** How long the platform keeps a CLI session, for sessions saved without `expiresAt`. */
const SESSION_TTL_MS = 300_000;
/** The platform allows 60 polls per session over its 5 minutes: one every 5 s. */
const POLL_MS = 5_000;

const PROVIDER_LABEL: Record<AuthProvider, string> = { github: "GitHub", google: "Google" };

interface Me {
  id: string;
  username: string;
  email?: string | null;
  scoped?: boolean;
}

interface Pending {
  sessionId: string;
  sessionSecret: string;
  expiresAt: number;
}

type Resumed =
  | { kind: "none" }
  | { kind: "complete" }
  | { kind: "pending"; pending: Pending }
  | { kind: "expired" };

export type AccountState =
  | "unknown"
  | "not_owner"
  | "enterprise"
  | "credits"
  | "past_due"
  | "trialing"
  | "active"
  | "trial_available"
  | "subscription_required"
  | "checkout_unavailable";

/** What the account still needs, from `GET /api/billing/subscription` (null when it could not be read). */
export function accountState(sub: Subscription | null): AccountState {
  if (!sub) return "unknown";
  if (sub.isOwner === false) return "not_owner";
  if (sub.plan === "enterprise") return "enterprise";
  if (sub.plan === "payg") return "credits";
  if (sub.plan === "pro") {
    if (sub.pastDue || sub.status === "past_due") return "past_due";
    return sub.status === "trialing" ? "trialing" : "active";
  }
  if (!sub.checkoutAvailable) return "checkout_unavailable";
  return sub.trial.eligible && sub.trial.days ? "trial_available" : "subscription_required";
}

/** What an agent should do about the plan. Spells out the don'ts, since an agent takes a link as a hint to open it. */
export function accountInstruction(state: AccountState, sub: Subscription | null, now = Date.now()): string {
  const price = usd(sub?.priceCents ?? 1900);
  const start =
    "Ask before starting it. If they agree, run `lizard billing start --json` and give them the url it prints to finish in Stripe Checkout.";
  switch (state) {
    case "unknown":
      return "Could not read this account's plan, so nothing about it is known. Do NOT start billing. The user is signed in: carry on with their task.";
    case "not_owner":
      return (
        "This account deploys on its workspace owner's plan. Do NOT start or change a subscription: only the owner can." +
        (sub?.plan === "none" ? " Deploys stay blocked until the owner starts Pro." : "")
      );
    case "enterprise":
      return "Enterprise plan, invoiced monthly. Nothing to set up.";
    case "credits":
      return `This account runs on prepaid credits, which end on ${CREDITS_END}. Deploys work until then. Tell the user that Pro replaces them (\`lizard billing start\`), but do not run it unless they ask.`;
    case "past_due":
      return "A payment failed, so new resources are blocked. Send the user to payUrl to pay the open invoice. Do NOT start a second subscription.";
    case "trialing": {
      const ends = sub?.trial.endsAt;
      const left = sub?.trial.remainingCents;
      const parts = [ends ? daysLeft(ends, now) : null, left != null ? `${usd(left)} of trial credits left` : null].filter(Boolean);
      return `The Pro trial is on${parts.length ? ` (${parts.join(", ")})` : ""}. Do NOT open billing or start a subscription.`;
    }
    case "active":
      return "Pro is active. Do NOT open billing or start a subscription.";
    case "trial_available":
      return (
        `No plan yet, and deploys need one. Offer the user the ${sub?.trial.days}-day Pro trial with ${usd(sub?.trial.creditCents ?? 0)} in credits: ` +
        `no charge today, then ${price}/month, taxes included. ${start}`
      );
    case "subscription_required":
      return (
        "No plan yet, and deploys need one. This account has had its trial, so do NOT promise one. " +
        `Pro is ${price}/month, taxes included, with ${usd(sub?.includedCents ?? 1900)} in credits each month. ${start}`
      );
    case "checkout_unavailable":
      return "No plan, and Pro is not open for this account yet. Do NOT try to start billing.";
  }
}

/** Commands an agent can run next. */
export function nextSteps(linked: boolean): Array<{ command: string; why: string }> {
  return [
    {
      command: "lizard skills get core",
      why: "The guide to every command, matched to this CLI version. Read it before running others.",
    },
    ...(linked ? [] : [{ command: "lizard init", why: "Create a project and link the current folder to it." }]),
    { command: "lizard up", why: linked ? "Deploy the linked folder." : "Deploy the folder once it is linked." },
  ];
}

/** The event that hands an agent the sign-in links. */
export function loginPendingEvent(
  pending: Pending,
  methods: AuthProvider[],
  why: "new" | "waiting" | "expired",
  flag?: AuthProvider,
  now = Date.now(),
) {
  const authUrls = Object.fromEntries(methods.map((m) => [m, authUrlFor(pending.sessionId, m)])) as Partial<
    Record<AuthProvider, string>
  >;
  const single = methods.length === 1 ? methods[0] : undefined;
  const minutes = Math.max(1, Math.round((pending.expiresAt - now) / 60_000));
  const window = minutes === 1 ? "1 more minute" : `${minutes} more minutes`;
  const lead =
    why === "waiting"
      ? "The user has not finished signing in yet. "
      : why === "expired"
        ? "The last sign-in link expired; this is a new one. "
        : "";
  const instruction = single
    ? `${lead}Sign-in is needed. Give the user authUrl to open. Once the browser says "CLI authorized", run nextCommand. ` +
      `The link works for ${window}; after that nextCommand prints a new one.`
    : `${lead}Sign-in is needed. Ask the user how they sign in to Lizard and give them that link from authUrls. ` +
      "Someone who already has an account must use the same method as before: another method opens a second, empty account " +
      "unless both share a verified email. A new user can pick either. " +
      `Once the browser says "CLI authorized", run nextCommand. The links work for ${window}; after that nextCommand prints new ones.`;
  return {
    event: "login_pending",
    ...(single ? { authUrl: authUrls[single] } : {}),
    authUrls,
    expiresAt: new Date(pending.expiresAt).toISOString(),
    nextCommand: flag ? `lizard onboard --${flag}` : "lizard onboard",
    instruction,
  };
}

/** The signed-in user, or null when this machine needs a sign-in. */
async function currentUser(): Promise<Me | null> {
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

/** Finish a session an earlier run (or `lizard login`) left on disk, if the browser approved it. */
async function resumePending(): Promise<Resumed> {
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

async function startSession(provider?: AuthProvider): Promise<Pending> {
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

async function fetchSubscription(): Promise<Subscription | null> {
  return api.get<Subscription>("/api/billing/subscription").catch(() => null);
}

// ── Agent mode ──────────────────────────────────────────────────────────

function emit(event: Record<string, unknown>) {
  process.stdout.write(JSON.stringify(event) + "\n");
}

async function onboardAgent(flag?: AuthProvider): Promise<void> {
  try {
    let source: "env" | "saved" | "browser" = envToken() ? "env" : "saved";
    let me = await currentUser();
    if (!me) {
      const resumed = await resumePending();
      if (resumed.kind !== "complete") {
        const pending = resumed.kind === "pending" ? resumed.pending : await startSession(flag);
        const methods = flag ? [flag] : await fetchAuthProviders();
        const why = resumed.kind === "pending" ? "waiting" : resumed.kind === "expired" ? "expired" : "new";
        emit(loginPendingEvent(pending, methods, why, flag));
        emit({ event: "done", signedIn: false });
        return;
      }
      source = "browser";
      me = await api.get<Me>("/api/auth/me");
    }

    emit({
      event: "signed_in",
      username: me.username,
      ...(me.email ? { email: me.email } : {}),
      ...(me.scoped ? { scoped: true } : {}),
      source,
    });

    const sub = await fetchSubscription();
    const state = accountState(sub);
    emit({
      event: "account",
      state,
      plan: sub?.plan ?? null,
      status: sub?.status ?? null,
      billingUrl: billingUrl(),
      ...(state === "past_due" ? { payUrl: sub?.openInvoiceUrl || billingUrl() } : {}),
      instruction: accountInstruction(state, sub),
      next: nextSteps(Boolean(getProjectLink())),
    });
    emit({ event: "done", signedIn: true });
  } catch (err: any) {
    emit({ event: "error", code: err?.code || "ERROR", message: err?.message || String(err) });
    process.exitCode = err?.status === 401 || err?.status === 403 ? 2 : 1;
  }
}

// ── Interactive mode ────────────────────────────────────────────────────

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

async function signInInBrowser(provider?: AuthProvider): Promise<Me> {
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
    cancelMessage: "Stopped waiting. The link works for a few more minutes: finish in the browser, then run any lizard command",
    onCancel: () => process.exit(5),
  });
  spin.start("Waiting for you to authorize Lizard CLI in the browser");
  const result = await waitForApproval(pending);
  if (!result?.accessToken || !result.user) {
    spin.error("The sign-in link expired");
    clearPendingAuth();
    throw new Error("The sign-in link expired. Run `lizard onboard` again.");
  }
  saveSessionLogin({ accessToken: result.accessToken, user: result.user });
  spin.stop("Authorized");
  return api.get<Me>("/api/auth/me");
}

async function offerPlan(canAsk: boolean): Promise<void> {
  const sub = await fetchSubscription();
  const state = accountState(sub);
  if (!sub) {
    p.log.message(chalk.dim("Could not read the plan. Run `lizard billing` to see it."));
    return;
  }
  if (state !== "trial_available" && state !== "subscription_required") {
    p.log.message(describeSubscription(sub).join("\n"));
    return;
  }

  const trial = state === "trial_available";
  const offer = trial
    ? `Pro trial: ${sub.trial.days} days with ${usd(sub.trial.creditCents ?? 0)} in credits. No charge today, then ${usd(sub.priceCents)}/month, taxes included.`
    : `Pro: ${usd(sub.priceCents)}/month, taxes included, with ${usd(sub.includedCents)} in credits each month.`;
  p.log.info(`No plan yet. Deploys need one.\n${offer}`);

  const go = canAsk ? await p.confirm({ message: trial ? "Start the trial now?" : "Start Pro now?" }) : false;
  if (p.isCancel(go) || !go) {
    p.log.message(`Start it later: ${chalk.cyan("lizard billing start")}`);
    return;
  }
  try {
    const out = await api.post<{ url: string }>("/api/billing/subscription/checkout", {});
    const opened = await openURL(out.url);
    p.log.info(`${opened ? "Opened Stripe Checkout. If it did not open, use this link" : "Finish in Stripe Checkout"}:\n${chalk.cyan(out.url)}`);
  } catch (err: any) {
    p.log.warn(`Could not open Stripe Checkout: ${err?.message || err}\nTry again with ${chalk.cyan("lizard billing start")}`);
  }
}

async function onboardPerson(flag?: AuthProvider): Promise<void> {
  // The installer hands the terminal over as stdin. Without it there is
  // nothing to answer with, so skip the questions and print the links.
  const canAsk = Boolean(process.stdin.isTTY);
  p.intro(chalk.bold("Lizard CLI"));

  let me = await currentUser();
  if (!me) {
    const resumed = await resumePending();
    me =
      resumed.kind === "complete"
        ? await api.get<Me>("/api/auth/me")
        : await signInInBrowser(flag ?? (canAsk ? await askProvider() : undefined));
  }
  p.log.success(`Signed in as ${chalk.bold(me.username)}`);

  await offerPlan(canAsk);

  const linked = Boolean(getProjectLink());
  p.note(
    (linked
      ? [`${chalk.cyan("lizard up")}     Deploy this folder`]
      : [`${chalk.cyan("lizard init")}   Create a project and link this folder`, `${chalk.cyan("lizard up")}     Deploy it`]
    ).join("\n"),
    "Next",
  );
  p.outro("You're all set");
}

export function registerOnboard(program: Command) {
  program
    .command("onboard")
    .description("Set up this machine after install: sign in, then only the steps the account still needs. Safe to re-run")
    .option("--github", "Sign in with GitHub")
    .option("--google", "Sign in with Google")
    .action(async (opts) => {
      const flag = providerFlag(opts);
      if (isJSONMode()) await onboardAgent(flag);
      else await onboardPerson(flag);
    });
}
