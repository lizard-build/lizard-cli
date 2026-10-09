import chalk from "chalk";
import open from "open";
import * as p from "@clack/prompts";
import { Command } from "commander";
import { api, withQuery, getBaseURL, isNotFound } from "../lib/api.js";
import { success, isJSONMode, printJSON, table, isTTY, timeAgo, info, warn } from "../lib/format.js";

// `lizard billing` — the account's plan (docs/pro-billing-api.md on the platform
// repo). Pro is $19/month, taxes included, with $19 of monthly credits; usage above
// that is pay as you go. Unlike most commands this never takes --project/--service:
// billing belongs to the account, not a workspace. `lizard credits` is the old name.

/** Old prepaid credits (`plan: "payg"`) keep working until this date. */
export const CREDITS_END = "November 1, 2026";
const BILLING_PATH = "/profile/account-billing";

export function billingUrl(): string {
  return `${getBaseURL()}${BILLING_PATH}`;
}

export interface Subscription {
  plan: "none" | "pro" | "payg" | "enterprise" | string;
  status: "none" | "trialing" | "active" | "past_due" | "canceled" | string;
  isOwner?: boolean;
  priceCents: number;
  taxIncluded: boolean;
  includedCents: number;
  trial: {
    eligible: boolean;
    days: number | null;
    creditCents: number | null;
    promoCode: string | null;
    endsAt: number | null;
    usedCents: number | null;
    remainingCents: number | null;
  };
  period: {
    kind: "trial" | "paid";
    start: number;
    end: number;
    includedCents: number;
    usedCents: number;
    overageCents: number;
    billedOverageCents: number;
    unbilledOverageCents: number;
    nextOverageChargeAtCents: number | null;
  } | null;
  nextCharge: { at: number | null; amountCents: number } | null;
  cancelAt: number | null;
  pastDue: boolean;
  openInvoiceUrl: string | null;
  paymentMethod: { brand: string; last4: string; expMonth: number; expYear: number } | null;
  limits: { tier: string; replicasPerApp: number } | null;
  checkoutAvailable: boolean;
}

interface BalanceView {
  plan: string;
  status: "active" | "grace" | "frozen";
  balanceCents: number;
  overdraftLimitCents: number | null;
  availableCents: number | null;
  expiringCents: number;
  expiringAt: number | null;
  hourlyRateCents: number;
  runwayHours: number | null;
  graceSince: number | null;
  graceHours: number;
  neverFreeze: boolean;
  invoicedMonthly: boolean;
  autoTopup?: { enabled: boolean; thresholdCents: number; amountCents: number; disabledReason: string | null };
  pendingPromo: { code: string; creditCents: number; expiresAt: number | null } | null;
}

interface CheckoutResult {
  url: string;
  sessionId: string;
  trialDays: number | null;
  trialCreditCents: number | null;
}

interface StartNowResult {
  status: "active" | "requires_action" | "failed" | string;
  invoiceUrl?: string | null;
}

/** New servers add the trial fields; older ones send only the first four. */
export interface PromoResult {
  status: string;
  code?: string;
  creditCents: number;
  expiresAt: number | null;
  balanceCents: number;
  trialDays?: number | null;
  trialCreditCents?: number | null;
  appliesTo?: "next_checkout" | "current_trial";
}

interface Transaction {
  id: string; kind: string; amountCents: number; balanceAfterCents: number | null;
  description: string | null; createdAt: number;
}

interface PaymentMethod {
  id: string; brand: string; last4: string; expMonth: number; expYear: number; isDefault?: boolean;
}

function fmtCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  return `${sign}$${(Math.abs(cents) / 100).toFixed(2)}`;
}

/** $19, $4.10: whole dollars without cents. */
export function usd(cents: number): string {
  return cents % 100 === 0 ? `$${cents / 100}` : fmtCents(cents);
}

function fmtDate(ms: number): string {
  return new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function daysLeft(endMs: number, now = Date.now()): string {
  const days = Math.max(0, Math.ceil((endMs - now) / 86_400_000));
  return days === 1 ? "1 day left" : `${days} days left`;
}

function statusLabel(status: string): string {
  switch (status) {
    case "active": return chalk.green(status);
    case "trialing": return chalk.green("trial");
    case "grace":
    case "past_due": return chalk.yellow(status.replace("_", " "));
    case "frozen":
    case "canceled": return chalk.red(status);
    default: return status;
  }
}

const creditsNotice = () => `Prepaid credits end on ${CREDITS_END}. Start Pro before then: lizard billing start`;

/** Lines that describe a plan, for people. Pure, so the tests can read it. */
export function describeSubscription(sub: Subscription, now = Date.now()): string[] {
  const lines: string[] = [];
  const label = (s: string) => chalk.dim(s);
  const owner = sub.isOwner === false ? chalk.dim(" (workspace owner's plan)") : "";

  if (sub.plan === "payg") {
    lines.push(`${chalk.bold("Prepaid credits")}${owner}`);
    lines.push(chalk.yellow(creditsNotice()));
    return lines;
  }

  if (sub.plan === "enterprise") {
    lines.push(`${chalk.bold("Enterprise")}${owner}`);
    lines.push("Pay as you go, invoiced monthly.");
    return lines;
  }

  if (sub.plan !== "pro") {
    lines.push(`${chalk.bold("No plan")}${owner}`);
    if (sub.status === "canceled") lines.push("Pro has ended.");
    if (sub.isOwner === false) {
      lines.push("The workspace owner has to start Pro.");
    } else if (!sub.checkoutAvailable) {
      lines.push("Pro is not open for this account yet.");
    } else if (sub.trial.eligible && sub.trial.days) {
      lines.push(
        `Start a ${sub.trial.days}-day Pro trial with ${usd(sub.trial.creditCents ?? 0)} in credits: ` +
          chalk.cyan("lizard billing start"),
      );
      lines.push(chalk.dim(`No charge today, then ${usd(sub.priceCents)}/month, taxes included.`));
      if (sub.trial.promoCode) lines.push(label("Promo code: ") + `${sub.trial.promoCode} (saved for the trial)`);
    } else {
      lines.push(
        `Start Pro: ${usd(sub.priceCents)}/month, taxes included, with ${usd(sub.includedCents)} in credits each month: ` +
          chalk.cyan("lizard billing start"),
      );
    }
    return lines;
  }

  lines.push(
    `${chalk.bold("Pro")}  ${statusLabel(sub.status)}${owner}  ` +
      chalk.dim(`${usd(sub.priceCents)}/month, taxes included`),
  );

  const period = sub.period;
  if (sub.status === "trialing") {
    if (sub.trial.endsAt) lines.push(label("Trial: ") + `${daysLeft(sub.trial.endsAt, now)}, ends ${fmtDate(sub.trial.endsAt)}`);
    const credit = sub.trial.creditCents ?? period?.includedCents ?? 0;
    const used = sub.trial.usedCents ?? period?.usedCents ?? 0;
    const left = sub.trial.remainingCents ?? Math.max(0, credit - used);
    lines.push(label("Trial credits: ") + `${usd(used)} of ${usd(credit)} used, ${usd(left)} left`);
  } else if (period) {
    lines.push(
      label("This month: ") +
        `${usd(period.usedCents)} of ${usd(period.includedCents)} used` +
        chalk.dim(` (${fmtDate(period.start)} to ${fmtDate(period.end)})`),
    );
    if (period.kind === "paid") {
      let overage = `${usd(period.overageCents)} this month`;
      if (period.overageCents > 0) {
        overage += `, ${usd(period.billedOverageCents)} invoiced so far`;
        if (period.nextOverageChargeAtCents) {
          overage += `; the next invoice goes out at ${usd(period.nextOverageChargeAtCents)}`;
        }
      }
      lines.push(label("Overage: ") + overage);
    }
  }

  if (sub.nextCharge?.at) {
    lines.push(label("Next charge: ") + `${usd(sub.nextCharge.amountCents)} on ${fmtDate(sub.nextCharge.at)}`);
  }
  if (sub.cancelAt) {
    lines.push(chalk.yellow(`Ends on ${fmtDate(sub.cancelAt)}.`) + " Run " + chalk.cyan("lizard billing resume") + " to keep Pro.");
  }
  if (sub.pastDue) {
    lines.push(chalk.red("A payment failed. New resources are blocked until the open invoice is paid."));
    if (sub.openInvoiceUrl) lines.push(label("Pay it: ") + chalk.cyan(sub.openInvoiceUrl));
  }
  if (sub.limits) {
    const n = sub.limits.replicasPerApp;
    lines.push(label("Replicas: ") + `up to ${n} per service`);
  }
  if (sub.paymentMethod) {
    const pm = sub.paymentMethod;
    lines.push(label("Card: ") + `${pm.brand} •••• ${pm.last4}` + chalk.dim(` (expires ${pm.expMonth}/${pm.expYear})`));
  }
  return lines;
}

async function fetchBalance(): Promise<BalanceView> {
  return api.get<BalanceView>("/api/billing/balance");
}

/** The prepaid credits view (old `payg` accounts until November 1, and enterprise usage). */
function printBalanceView(view: BalanceView) {
  console.log(`${chalk.bold(fmtCents(view.balanceCents))}  ${statusLabel(view.status)}  ${chalk.dim(`(${view.plan})`)}`);

  if (view.neverFreeze) {
    console.log(chalk.dim("Exempt from billing freeze — balance can go negative with no enforcement."));
  } else {
    if (view.overdraftLimitCents != null) {
      console.log(chalk.dim(`Overdraft limit: `) + fmtCents(-view.overdraftLimitCents));
    }
    if (view.availableCents != null) {
      console.log(chalk.dim(`Available before freeze: `) + fmtCents(view.availableCents));
    }
    if (view.graceSince) {
      const deadline = view.graceSince + view.graceHours * 3_600_000;
      const hoursLeft = Math.max(0, Math.round((deadline - Date.now()) / 3_600_000));
      console.log(chalk.yellow(`In grace since ${timeAgo(view.graceSince)} — freezes in ~${hoursLeft}h if unpaid.`));
    }
  }

  if (view.expiringCents > 0 && view.expiringAt) {
    console.log(chalk.dim(`Expiring: `) + `${fmtCents(view.expiringCents)} by ${new Date(view.expiringAt).toLocaleDateString()}`);
  }

  if (view.hourlyRateCents > 0) {
    const rate = chalk.dim(`(~${fmtCents(view.hourlyRateCents)}/hr)`);
    if (view.runwayHours != null) {
      const days = (view.runwayHours / 24).toFixed(1);
      console.log(chalk.dim(`Runway: `) + `~${view.runwayHours}h (${days}d) at current usage ${rate}`);
    } else {
      console.log(chalk.dim(`Current usage rate: `) + rate);
    }
  }

  if (view.autoTopup) {
    console.log(
      chalk.dim("Auto top-up: ") +
        (view.autoTopup.enabled
          ? `on — tops up ${fmtCents(view.autoTopup.amountCents)} when balance drops below ${fmtCents(view.autoTopup.thresholdCents)}`
          : "off"),
    );
    if (view.autoTopup.disabledReason) {
      console.log(chalk.yellow(`  disabled: ${view.autoTopup.disabledReason}`));
    }
  }

  if (view.pendingPromo) {
    console.log(chalk.dim("Pending promo: ") + `${view.pendingPromo.code} (${fmtCents(view.pendingPromo.creditCents)})`);
  }
}

async function showStatus(opts: { workspace?: string }) {
  let sub: Subscription;
  try {
    sub = await api.get<Subscription>(withQuery("/api/billing/subscription", { workspaceId: opts.workspace }));
  } catch (e) {
    // A server without Pro yet: the prepaid credits view is all there is.
    if (!isNotFound(e) || opts.workspace) throw e;
    const view = await fetchBalance();
    if (isJSONMode()) printJSON(view);
    else printBalanceView(view);
    return;
  }

  const url = billingUrl();
  const ownPrepaid = sub.plan === "payg" && sub.isOwner !== false;
  const balance = ownPrepaid ? await fetchBalance() : null;

  if (isJSONMode()) {
    printJSON({
      ...sub,
      billingUrl: url,
      ...(balance ? { balance, notice: `Prepaid credits end on ${CREDITS_END}.` } : {}),
    });
    return;
  }

  if (sub.plan === "payg") {
    if (balance) printBalanceView(balance);
    else console.log(`${chalk.bold("Prepaid credits")}${chalk.dim(" (workspace owner's plan)")}`);
    console.log(chalk.yellow(creditsNotice()));
  } else {
    for (const line of describeSubscription(sub)) console.log(line);
  }
  console.log(chalk.dim("Billing: ") + chalk.cyan(url));
}

async function confirmOrExit(message: string, yes: boolean | undefined) {
  if (yes) return;
  if (!isTTY()) throw new Error("Use -y to confirm in non-interactive mode");
  const confirmed = await p.confirm({ message });
  if (p.isCancel(confirmed) || !confirmed) process.exit(5);
}

async function openInBrowser(url: string, wanted: boolean) {
  if (wanted && isTTY() && !isJSONMode()) await open(url).catch(() => {});
}

/** One line for a redeemed promo code. Works with servers before and after Pro. */
export function describePromo(out: PromoResult): string {
  if (out.trialDays != null) {
    const credits = usd(out.trialCreditCents ?? out.creditCents);
    if (out.appliesTo === "current_trial") {
      const until = out.expiresAt ? `, until ${fmtDate(out.expiresAt)}` : "";
      return `Your trial now runs ${out.trialDays} days with ${credits} in credits${until}.`;
    }
    const code = out.code ? `Code ${out.code} saved: ` : "Code saved: ";
    return `${code}a ${out.trialDays}-day Pro trial with ${credits} in credits. Start it with \`lizard billing start\`.`;
  }
  if (out.status === "pending_payment_method") {
    return `Code saved: ${fmtCents(out.creditCents)} in credits. They unlock when you start your trial in Billing.`;
  }
  return `Redeemed ${fmtCents(out.creditCents)}. New balance: ${fmtCents(out.balanceCents)}.`;
}

export function registerBilling(program: Command) {
  const cmd = program
    .command("billing")
    .alias("credits")
    .description("Your plan: Pro trial, this month's credits, next charge, cancel or resume (`credits` is the old name)")
    .option("-w, --workspace <id>", "Show the plan of this workspace's owner")
    .action(async () => {
      await showStatus(cmd.opts());
    });

  cmd.hook("preAction", (thisCommand) => {
    if (thisCommand.parent?.args[0] === "credits") {
      warn("`lizard credits` is now `lizard billing`. The old name will go away in a later release.");
    }
  });

  cmd
    .command("status")
    .description("Show the plan, trial, this month's credits and the next charge")
    .option("-w, --workspace <id>", "Show the plan of this workspace's owner")
    .action(async (opts) => {
      // `billing` takes -w too and claims it wherever it appears on the line.
      await showStatus({ ...cmd.opts(), ...opts });
    });

  cmd
    .command("open")
    .description("Open the Billing page in the browser")
    .option("--no-open", "Print the link instead of opening a browser")
    .action(async (opts) => {
      const url = billingUrl();
      if (isJSONMode()) {
        printJSON({ url, opened: false });
        return;
      }
      console.log(chalk.cyan(url));
      await openInBrowser(url, opts.open !== false);
    });

  cmd
    .command("start")
    .description("Start Pro in Stripe Checkout: the trial if the account can have one, otherwise Pro at once")
    .option("--return-url <path>", "Dashboard path to come back to after Checkout, e.g. /projects/abc")
    .option("--no-open", "Print the Checkout link instead of opening a browser")
    .action(async (opts) => {
      const out = await api.post<CheckoutResult>("/api/billing/subscription/checkout", { returnUrl: opts.returnUrl });
      if (isJSONMode()) {
        printJSON(out);
        return;
      }
      if (out.trialDays) {
        console.log(
          `Your ${out.trialDays}-day trial includes ${usd(out.trialCreditCents ?? 0)} in credits. ` +
            "No charge today, then $19/month, taxes included.",
        );
      } else {
        console.log("Pro starts today: $19/month, taxes included, with $19 in credits each month.");
      }
      console.log(`Finish in Stripe Checkout:\n${chalk.cyan(out.url)}`);
      await openInBrowser(out.url, opts.open !== false);
      info(chalk.dim("Run `lizard billing` when you are done."));
    });

  cmd
    .command("start-now")
    .description("End the trial now: charge $19 and start the first paid month with $19 in credits")
    .option("-y, --yes", "Skip confirmation")
    .option("--no-open", "Print the payment link instead of opening a browser")
    .action(async (opts) => {
      await confirmOrExit("End the trial and charge $19 now?", opts.yes);
      const out = await api.post<StartNowResult>("/api/billing/subscription/start-now", {});
      if (out.status === "failed") {
        throw Object.assign(
          new Error(`The charge failed, so your trial continues. Check your card in Billing:\n  ${billingUrl()}`),
          { code: "PAYMENT_FAILED" },
        );
      }
      if (isJSONMode()) {
        printJSON(out);
        return;
      }
      if (out.status === "requires_action" && out.invoiceUrl) {
        console.log(`Your bank needs you to confirm the payment. Your trial continues until you do:\n${chalk.cyan(out.invoiceUrl)}`);
        await openInBrowser(out.invoiceUrl, opts.open !== false);
        return;
      }
      success("Pro is active. We charged $19 and added $19 in credits for this month.");
    });

  cmd
    .command("cancel")
    .description("Cancel Pro at the end of this month or trial; nothing is charged after that")
    .option("-y, --yes", "Skip confirmation")
    .action(async (opts) => {
      await confirmOrExit("Cancel Pro at the end of the current period?", opts.yes);
      const out = await api.post<{ cancelAt: number | null }>("/api/billing/subscription/cancel", {});
      if (isJSONMode()) {
        printJSON(out);
        return;
      }
      success(
        out.cancelAt
          ? `Pro ends on ${fmtDate(out.cancelAt)}. Run \`lizard billing resume\` to keep it.`
          : "Pro is cancelled.",
      );
    });

  cmd
    .command("resume")
    .description("Undo a cancel: keep Pro after the current period")
    .action(async () => {
      const out = await api.post<{ cancelAt: null }>("/api/billing/subscription/resume", {});
      if (isJSONMode()) {
        printJSON(out);
        return;
      }
      success("Pro continues. It renews as usual.");
    });

  cmd
    .command("promo <code>")
    .description("Redeem a promo code: a longer Pro trial with more trial credits")
    .action(async (code: string) => {
      const out = await api.post<PromoResult>("/api/billing/promo/redeem", { code });
      if (isJSONMode()) {
        printJSON(out);
        return;
      }
      success(describePromo(out));
    });

  cmd
    .command("balance")
    .description(`Prepaid credits balance (old credits accounts until ${CREDITS_END}, and enterprise)`)
    .action(async () => {
      const view = await fetchBalance();
      if (isJSONMode()) {
        printJSON(view);
        return;
      }
      printBalanceView(view);
    });

  cmd
    .command("transactions")
    .alias("ledger")
    .description("List recent balance transactions (prepaid credits and enterprise accounts)")
    .option("-l, --limit <n>", "Max results (1-100)", "20")
    .option("-c, --cursor <cursor>", "Pagination cursor from a previous call")
    .option("-u, --usage", "Include daily usage-deduction rows")
    .action(async (opts) => {
      const page = await api.get<{ items: Transaction[]; nextCursor: string | null }>(
        withQuery("/api/billing/transactions", {
          limit: opts.limit,
          cursor: opts.cursor,
          includeUsage: opts.usage ? "1" : undefined,
        }),
      );

      if (isJSONMode()) {
        printJSON(page);
        return;
      }

      if (page.items.length === 0) {
        console.log("No transactions.");
        return;
      }

      table(
        ["When", "Kind", "Amount", "Balance after", "Description"],
        page.items.map((t) => [
          timeAgo(t.createdAt),
          t.kind,
          t.amountCents >= 0 ? chalk.green(fmtCents(t.amountCents)) : chalk.red(fmtCents(t.amountCents)),
          t.balanceAfterCents != null ? fmtCents(t.balanceAfterCents) : "—",
          t.description ?? "",
        ]),
      );

      if (page.nextCursor) {
        console.log(chalk.dim(`\nMore results: lizard billing transactions --cursor ${page.nextCursor}`));
      }
    });

  // ── Payment methods ───────────────────────────────────────────────
  const pm = cmd.command("payment-methods").alias("pm").description("List or remove saved cards (add a card in Billing)");

  pm.command("list")
    .description("List saved cards")
    .action(async () => {
      const { items } = await api.get<{ items: PaymentMethod[] }>("/api/billing/payment-methods");
      if (isJSONMode()) {
        printJSON(items);
        return;
      }
      if (items.length === 0) {
        console.log(`No saved cards. Add one in Billing: ${chalk.cyan(billingUrl())}`);
        return;
      }
      table(
        ["ID", "Card", "Expires", "Default"],
        items.map((m) => [m.id, `${m.brand} •••• ${m.last4}`, `${m.expMonth}/${m.expYear}`, m.isDefault ? "yes" : ""]),
      );
    });

  pm.command("remove <id>")
    .alias("rm")
    .description("Remove a saved card")
    .option("-y, --yes", "Skip confirmation")
    .action(async (id: string, opts) => {
      await confirmOrExit(`Remove payment method ${chalk.bold(id)}?`, opts.yes);
      const out = await api.delete<{ ok: boolean }>(`/api/billing/payment-methods/${encodeURIComponent(id)}`);
      if (isJSONMode()) {
        printJSON(out);
      } else {
        success("Payment method removed");
      }
    });
}
