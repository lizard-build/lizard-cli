import chalk from "chalk";
import open from "open";
import * as p from "@clack/prompts";
import { Command } from "commander";
import { api, withQuery, APIError } from "../lib/api.js";
import { success, isJSONMode, printJSON, table, isTTY, timeAgo } from "../lib/format.js";

interface BalanceView {
  plan: string;
  status: "active" | "grace" | "frozen";
  balanceCents: number;
  overdraftLimitCents: number | null;
  availableCents: number | null;
  expiringCents: number;
  expiringAt: number | null;
  expiringCredits: { amountCents: number; expiresAt: number }[];
  hourlyRateCents: number;
  runwayHours: number | null;
  graceSince: number | null;
  graceHours: number;
  neverFreeze: boolean;
  invoicedMonthly: boolean;
  email: string | null;
  autoTopup: {
    enabled: boolean; thresholdCents: number; amountCents: number;
    paymentMethodIds: string[]; disabledReason: string | null;
    lastAttemptAt: number | null; lastSuccessAt: number | null; consecutiveFailures: number;
  };
  pendingPromo: { code: string; creditCents: number; expiresAt: number | null } | null;
  topupUrl: string;
  purchase: { minCents: number; maxCents: number; feeBps: number; feeMinCents: number; feeFixedCents: number; feeInternationalBps: number; cryptoEnabled: boolean };
}

// `lizard credits` — account-scoped prepaid balance (LIZARD-177). Unlike
// most commands this never takes --project/--service: billing belongs to
// the user, not a workspace. See docs/credits-api.md on the platform repo
// for the contract this is built against.

function fmtCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  return `${sign}$${(Math.abs(cents) / 100).toFixed(2)}`;
}

/** Accepts "10", "10.5", "$10.50" -> cents. Throws on anything else. */
function parseDollarsToCents(input: string): number {
  const cleaned = input.trim().replace(/^\$/, "");
  const value = Number(cleaned);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid amount: "${input}". Use a positive dollar amount, e.g. 10 or 10.50.`);
  }
  return Math.round(value * 100);
}

function statusLabel(status: string): string {
  switch (status) {
    case "active": return chalk.green(status);
    case "grace": return chalk.yellow(status);
    case "frozen": return chalk.red(status);
    default: return status;
  }
}

async function printBalance(): Promise<BalanceView> {
  const view = await api.get<BalanceView>("/api/billing/balance");
  if (isJSONMode()) {
    printJSON(view);
    return view;
  }

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

  console.log(
    chalk.dim("Auto top-up: ") +
      (view.autoTopup.enabled
        ? `on — tops up ${fmtCents(view.autoTopup.amountCents)} when balance drops below ${fmtCents(view.autoTopup.thresholdCents)}`
        : "off"),
  );
  if (view.autoTopup.disabledReason) {
    console.log(chalk.yellow(`  disabled: ${view.autoTopup.disabledReason}`));
  }

  if (view.pendingPromo) {
    console.log(chalk.dim("Pending promo: ") + `${view.pendingPromo.code} (${fmtCents(view.pendingPromo.creditCents)})`);
  }

  return view;
}

interface Transaction {
  id: string; kind: string; amountCents: number; balanceAfterCents: number | null;
  description: string | null; createdAt: number; externalRef: string | null;
  receiptUrl: string | null; invoiceUrl: string | null; expiresAt: number | null;
}

interface PaymentMethod {
  id: string; brand: string; last4: string; expMonth: number; expYear: number; isDefault?: boolean;
}

export function registerCredits(program: Command) {
  const cmd = program
    .command("credits")
    .alias("billing")
    .description("Account balance, usage, and top-ups (prepaid credits)")
    .action(async () => {
      await printBalance();
    });

  cmd
    .command("balance")
    .description("Show current balance, status, and runway")
    .action(async () => {
      await printBalance();
    });

  cmd
    .command("transactions")
    .alias("ledger")
    .description("List recent balance transactions")
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
        console.log(chalk.dim(`\nMore results: lizard credits transactions --cursor ${page.nextCursor}`));
      }
    });

  // ── Payment methods ───────────────────────────────────────────────
  const pm = cmd.command("payment-methods").alias("pm").description("Manage saved payment methods");

  pm.command("list")
    .description("List saved payment methods")
    .action(async () => {
      const { items } = await api.get<{ items: PaymentMethod[] }>("/api/billing/payment-methods");
      if (isJSONMode()) {
        printJSON(items);
        return;
      }
      if (items.length === 0) {
        console.log("No saved payment methods. Add one with `lizard credits payment-methods add`.");
        return;
      }
      table(
        ["ID", "Card", "Expires", "Default"],
        items.map((m) => [m.id, `${m.brand} •••• ${m.last4}`, `${m.expMonth}/${m.expYear}`, m.isDefault ? "yes" : ""]),
      );
    });

  pm.command("add")
    .description("Save a new card via a Stripe Checkout link")
    .option("--return-url <url>", "Where to redirect after saving the card")
    .option("--no-open", "Print the link instead of opening a browser")
    .action(async (opts) => {
      const { url } = await api.post<{ url: string }>("/api/billing/payment-methods/setup", {
        returnUrl: opts.returnUrl,
      });
      if (isJSONMode()) {
        printJSON({ url });
        return;
      }
      console.log(`Open this link to save a card:\n${chalk.cyan(url)}`);
      if (opts.open !== false && isTTY()) await open(url).catch(() => {});
    });

  pm.command("remove <id>")
    .alias("rm")
    .description("Remove a saved payment method")
    .option("-y, --yes", "Skip confirmation")
    .action(async (id: string, opts) => {
      if (!opts.yes) {
        if (!isTTY()) throw new Error("Use -y to confirm in non-interactive mode");
        const confirm = await p.confirm({ message: `Remove payment method ${chalk.bold(id)}?` });
        if (p.isCancel(confirm) || !confirm) process.exit(5);
      }
      const out = await api.delete<{ ok: boolean }>(`/api/billing/payment-methods/${encodeURIComponent(id)}`);
      if (isJSONMode()) {
        printJSON(out);
      } else {
        success("Payment method removed");
      }
    });

  // ── Top up ────────────────────────────────────────────────────────
  cmd
    .command("topup <amount>")
    .alias("purchase")
    .description("Buy credits (amount in dollars, e.g. `lizard credits topup 20`)")
    .option("--method <method>", "card or crypto", "card")
    .option("--return-url <url>", "Where to redirect after payment")
    .option("--no-open", "Print the checkout link instead of opening a browser")
    .action(async (amount: string, opts) => {
      const creditCents = parseDollarsToCents(amount);
      if (opts.method !== "card" && opts.method !== "crypto") {
        throw new Error(`--method must be "card" or "crypto", got "${opts.method}"`);
      }
      let out: { url?: string; sessionId?: string };
      try {
        out = await api.post("/api/billing/purchase", {
          creditCents,
          paymentMethod: opts.method,
          returnUrl: opts.returnUrl,
        });
      } catch (e) {
        if (e instanceof APIError && e.status === 409 && e.message === "CREDITS_NOT_ENABLED") {
          throw new Error("Credits purchases aren't available yet on this account.");
        }
        throw e;
      }
      if (isJSONMode()) {
        printJSON(out);
        return;
      }
      if (!out.url) throw new Error("No checkout URL returned.");
      console.log(`Complete payment (${fmtCents(creditCents)}) at:\n${chalk.cyan(out.url)}`);
      if (opts.open !== false && isTTY()) await open(out.url).catch(() => {});
    });

  // ── Auto top-up ───────────────────────────────────────────────────
  const auto = cmd.command("auto-topup").description("Show or configure automatic top-up");

  auto.action(async () => {
    const settings = await api.get("/api/billing/auto-topup");
    if (isJSONMode()) { printJSON(settings); return; }
    console.log(JSON.stringify(settings, null, 2));
  });

  auto
    .command("set")
    .description("Configure automatic top-up")
    .requiredOption("--payment-method <id...>", "Payment method ID(s) to charge, in priority order")
    .option("--threshold <amount>", "Top up when balance drops below this (dollars)", "5")
    .option("--amount <amount>", "How much to add per top-up (dollars)", "20")
    .option("--disable", "Turn auto top-up off instead of configuring it")
    .action(async (opts) => {
      const body = {
        enabled: !opts.disable,
        thresholdCents: parseDollarsToCents(opts.threshold),
        amountCents: parseDollarsToCents(opts.amount),
        paymentMethodIds: opts.paymentMethod,
      };
      const out = await api.put("/api/billing/auto-topup", body);
      if (isJSONMode()) { printJSON(out); return; }
      success(opts.disable ? "Auto top-up disabled" : "Auto top-up configured");
    });

  auto
    .command("run")
    .description("Manually trigger an auto top-up check now")
    .action(async () => {
      try {
        const out = await api.post<{ ok: boolean; creditedCents?: number; balanceCents?: number }>(
          "/api/billing/auto-topup/run",
          {},
        );
        if (isJSONMode()) { printJSON(out); return; }
        if (out.ok) {
          success(`Topped up ${fmtCents(out.creditedCents ?? 0)} — new balance ${fmtCents(out.balanceCents ?? 0)}`);
        }
      } catch (e) {
        if (e instanceof APIError && e.status === 429) {
          throw new Error(`Auto top-up rate-limited: ${(e.body as any)?.reason ?? e.message}`);
        }
        throw e;
      }
    });

  // ── Promo codes ───────────────────────────────────────────────────
  cmd
    .command("promo <code>")
    .description("Redeem a promo code")
    .action(async (code: string) => {
      try {
        const out = await api.post<{ status: string; creditCents: number; expiresAt: number | null; balanceCents: number }>(
          "/api/billing/promo/redeem",
          { code },
        );
        if (isJSONMode()) { printJSON(out); return; }
        success(`Redeemed ${fmtCents(out.creditCents)} — new balance ${fmtCents(out.balanceCents)}`);
      } catch (e) {
        if (e instanceof APIError) throw new Error((e.body as any)?.message ?? e.message);
        throw e;
      }
    });
}
