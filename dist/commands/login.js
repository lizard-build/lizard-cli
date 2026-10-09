import chalk from "chalk";
import * as p from "@clack/prompts";
import { saveCredentials, jwtExpiryMs, envToken, openURL } from "../lib/auth.js";
import { api, getBaseURL } from "../lib/api.js";
import { getProjectLink } from "../lib/config.js";
import { success, isJSONMode, printJSON } from "../lib/format.js";
import { currentUser, fetchAuthProviders, pendingPayload, providerFlag, resumePending, signInInteractive, startSession, } from "../lib/signin.js";
import { CREDITS_END, billingUrl, daysLeft, describeSubscription, usd } from "./billing.js";
/** What the account still needs, from `GET /api/billing/subscription` (null when it could not be read). */
export function accountState(sub) {
    if (!sub)
        return "unknown";
    if (sub.isOwner === false)
        return "not_owner";
    if (sub.plan === "enterprise")
        return "enterprise";
    if (sub.plan === "payg")
        return "credits";
    if (sub.plan === "pro") {
        if (sub.pastDue || sub.status === "past_due")
            return "past_due";
        return sub.status === "trialing" ? "trialing" : "active";
    }
    if (!sub.checkoutAvailable)
        return "checkout_unavailable";
    return sub.trial.eligible && sub.trial.days ? "trial_available" : "subscription_required";
}
/** What an agent should do about the plan. Spells out the don'ts, since an agent takes a link as a hint to open it. */
export function accountInstruction(state, sub, now = Date.now()) {
    const price = usd(sub?.priceCents ?? 1900);
    const start = "Ask before starting it. If they agree, run `lizard billing start --json` and give them the url it prints to finish in Stripe Checkout.";
    switch (state) {
        case "unknown":
            return "Could not read this account's plan, so nothing about it is known. Do NOT start billing. The user is signed in: carry on with their task.";
        case "not_owner":
            return ("This account deploys on its workspace owner's plan. Do NOT start or change a subscription: only the owner can." +
                (sub?.plan === "none" ? " Deploys stay blocked until the owner starts Pro." : ""));
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
            return (`No plan yet, and deploys need one. Offer the user the ${sub?.trial.days}-day Pro trial with ${usd(sub?.trial.creditCents ?? 0)} in credits: ` +
                `no charge today, then ${price}/month, taxes included. ${start}`);
        case "subscription_required":
            return ("No plan yet, and deploys need one. This account has had its trial, so do NOT promise one. " +
                `Pro is ${price}/month, taxes included, with ${usd(sub?.includedCents ?? 1900)} in credits each month. ${start}`);
        case "checkout_unavailable":
            return "No plan, and Pro is not open for this account yet. Do NOT try to start billing.";
    }
}
/** Commands an agent can run next. */
export function nextSteps(linked) {
    return [
        {
            command: "lizard skills get core",
            why: "The guide to every command, matched to this CLI version. Read it before running others.",
        },
        ...(linked ? [] : [{ command: "lizard init", why: "Create a project and link the current folder to it." }]),
        { command: "lizard up", why: linked ? "Deploy the linked folder." : "Deploy the folder once it is linked." },
    ];
}
async function fetchSubscription() {
    return api.get("/api/billing/subscription").catch(() => null);
}
// ── For agents ──────────────────────────────────────────────────────────
async function loginForAgent(flag) {
    let source = envToken() ? "env" : "saved";
    let me = await currentUser();
    if (!me) {
        const resumed = await resumePending();
        if (resumed.kind !== "complete") {
            const pending = resumed.kind === "pending" ? resumed.pending : await startSession(flag);
            const methods = flag ? [flag] : await fetchAuthProviders();
            const why = resumed.kind === "pending" ? "waiting" : resumed.kind === "expired" ? "expired" : "new";
            printJSON(pendingPayload(pending, methods, why, { flag, nextCommand: flag ? `lizard login --${flag}` : "lizard login" }));
            return;
        }
        source = "browser";
        me = await api.get("/api/auth/me");
    }
    const sub = await fetchSubscription();
    const state = accountState(sub);
    printJSON({
        status: "complete",
        username: me.username,
        ...(me.email ? { email: me.email } : {}),
        ...(me.scoped ? { scoped: true } : {}),
        source,
        account: {
            state,
            plan: sub?.plan ?? null,
            status: sub?.status ?? null,
            billingUrl: billingUrl(),
            ...(state === "past_due" ? { payUrl: sub?.openInvoiceUrl || billingUrl() } : {}),
            instruction: accountInstruction(state, sub),
        },
        next: nextSteps(Boolean(getProjectLink())),
    });
}
// ── For people ──────────────────────────────────────────────────────────
async function offerPlan(canAsk) {
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
        const out = await api.post("/api/billing/subscription/checkout", {});
        const opened = await openURL(out.url);
        p.log.info(`${opened ? "Opened Stripe Checkout. If it did not open, use this link" : "Finish in Stripe Checkout"}:\n${chalk.cyan(out.url)}`);
    }
    catch (err) {
        p.log.warn(`Could not open Stripe Checkout: ${err?.message || err}\nTry again with ${chalk.cyan("lizard billing start")}`);
    }
}
async function loginInteractive(flag) {
    // The install script hands the terminal over as stdin. Without it there is
    // nothing to answer with, so skip the questions and print the links.
    const canAsk = Boolean(process.stdin.isTTY);
    p.intro(chalk.bold("Lizard CLI"));
    const me = await currentUser();
    if (me) {
        p.log.success(`Signed in as ${chalk.bold(me.username)}`);
        p.log.message(chalk.dim("To use another account: lizard logout, then lizard login."));
    }
    else if ((await resumePending()).kind === "complete") {
        const resumed = await api.get("/api/auth/me");
        p.log.success(`Signed in as ${chalk.bold(resumed.username)}`);
    }
    else {
        await signInInteractive(flag);
    }
    await offerPlan(canAsk);
    const linked = Boolean(getProjectLink());
    p.note((linked
        ? [`${chalk.cyan("lizard up")}     Deploy this folder`]
        : [`${chalk.cyan("lizard init")}   Create a project and link this folder`, `${chalk.cyan("lizard up")}     Deploy it`]).join("\n"), "Next");
    p.outro("You're all set");
}
/** Validate a token, save it as this machine's login, and say who it belongs to. */
async function loginWithToken(token) {
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
}
/**
 * The token piped into `--token-stdin`. A token in `--token` shows up in the
 * process list and the shell history; one on stdin does not. A terminal on
 * stdin would sit waiting for an end-of-file nobody knows to type, so refuse.
 */
export async function readTokenFromStdin(stdin = process.stdin) {
    if (stdin.isTTY) {
        throw new Error('--token-stdin reads a piped token, e.g. printf \'%s\' "$LIZARD_TOKEN" | lizard login --token-stdin');
    }
    let raw = "";
    for await (const chunk of stdin)
        raw += chunk.toString();
    const token = raw.trim();
    if (!token)
        throw new Error("--token-stdin got nothing on stdin.");
    return token;
}
export function registerLogin(program) {
    program
        .command("login")
        .description("Sign in to Lizard, then offer Pro if the account has no plan. Safe to re-run")
        .option("--token <token>", "Authenticate with an API token")
        .option("--token-stdin", "Read the API token from stdin, which keeps it out of the process list and shell history")
        .option("--github", "Sign in with GitHub")
        .option("--google", "Sign in with Google")
        .action(async (opts) => {
        const flag = providerFlag(opts);
        if (opts.token && opts.tokenStdin)
            throw new Error("Pass --token or --token-stdin, not both.");
        if (opts.token || opts.tokenStdin) {
            await loginWithToken(opts.token ?? (await readTokenFromStdin()));
            return;
        }
        if (isJSONMode())
            await loginForAgent(flag);
        else
            await loginInteractive(flag);
    });
}
//# sourceMappingURL=login.js.map