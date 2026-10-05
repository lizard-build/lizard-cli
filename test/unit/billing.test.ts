import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Command } from "commander";
import { registerBilling, describePromo, type Subscription } from "../../src/commands/billing.js";
import { setAccessToken, setBaseURL } from "../../src/lib/api.js";
import { setJSONMode } from "../../src/lib/format.js";

const fetchMock = vi.fn();
let stdout: string[];
let stderr: string[];

const ANSI = /\x1b\[[0-9;]*m/g;
const out = () => stdout.join("\n").replace(ANSI, "");
const err = () => stderr.join("").replace(ANSI, "");

function reply(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** Answers each request by "METHOD path" (path includes the query). */
function routes(table: Record<string, () => Response>) {
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${new URL(url).pathname}${new URL(url).search}`;
    const handler = table[key];
    if (!handler) return reply(404, { error: `no route ${key}` });
    return handler();
  });
}

function calls() {
  return fetchMock.mock.calls.map(([url, init]) => ({
    key: `${init?.method ?? "GET"} ${new URL(url).pathname}${new URL(url).search}`,
    body: init?.body ? JSON.parse(init.body as string) : undefined,
  }));
}

function run(args: string[]) {
  const program = new Command().exitOverride().configureOutput({ writeErr: () => {}, writeOut: () => {} });
  registerBilling(program);
  return program.parseAsync(args, { from: "user" });
}

const DAY = 86_400_000;
const now = Date.now();

const base: Subscription = {
  plan: "pro",
  status: "trialing",
  isOwner: true,
  priceCents: 1900,
  taxIncluded: true,
  includedCents: 1900,
  trial: { eligible: false, days: 7, creditCents: 500, promoCode: null, endsAt: now + 5 * DAY - 1000, usedCents: 120, remainingCents: 380 },
  period: {
    kind: "trial", start: now - 2 * DAY, end: now + 5 * DAY, includedCents: 500, usedCents: 120,
    overageCents: 0, billedOverageCents: 0, unbilledOverageCents: 0, nextOverageChargeAtCents: null,
  },
  nextCharge: { at: now + 5 * DAY, amountCents: 1900 },
  cancelAt: null,
  pastDue: false,
  openInvoiceUrl: null,
  paymentMethod: { brand: "visa", last4: "4242", expMonth: 12, expYear: 2030 },
  limits: { tier: "trial", replicasPerApp: 1 },
  checkoutAvailable: true,
};

const paid: Subscription = {
  ...base,
  status: "active",
  trial: { ...base.trial, endsAt: null, usedCents: null, remainingCents: null },
  period: {
    kind: "paid", start: now - 10 * DAY, end: now + 20 * DAY, includedCents: 1900, usedCents: 3140,
    overageCents: 1240, billedOverageCents: 0, unbilledOverageCents: 1240, nextOverageChargeAtCents: 2000,
  },
  nextCharge: { at: now + 20 * DAY, amountCents: 3140 },
  limits: { tier: "pro", replicasPerApp: 5 },
};

const none: Subscription = {
  ...base,
  plan: "none",
  status: "none",
  trial: { eligible: true, days: 7, creditCents: 500, promoCode: null, endsAt: null, usedCents: null, remainingCents: null },
  period: null,
  nextCharge: null,
  paymentMethod: null,
  limits: null,
};

const balance = {
  plan: "payg", status: "active", balanceCents: 1234, overdraftLimitCents: 100, availableCents: 1334,
  expiringCents: 0, expiringAt: null, hourlyRateCents: 0, runwayHours: null, graceSince: null, graceHours: 72,
  neverFreeze: false, invoicedMonthly: false, pendingPromo: null,
  autoTopup: { enabled: false, thresholdCents: 500, amountCents: 2000, disabledReason: null },
};

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  setBaseURL("https://lizard.build");
  setAccessToken("test-token");
  setJSONMode(false);
  stdout = [];
  stderr = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { stdout.push(a.join(" ")); });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: any) => { stderr.push(String(chunk)); return true; });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setJSONMode(false);
});

describe("lizard billing (status)", () => {
  test("a trial shows days left, trial credits, the next charge and the Billing link", async () => {
    routes({ "GET /api/billing/subscription": () => reply(200, base) });
    await run(["billing"]);
    const text = out();
    expect(text).toContain("Pro  trial");
    expect(text).toContain("$19/month, taxes included");
    expect(text).toContain("Trial: 5 days left");
    expect(text).toContain("Trial credits: $1.20 of $5 used, $3.80 left");
    expect(text).toMatch(/Next charge: \$19 on \w{3} \d+, \d{4}/);
    expect(text).toContain("Replicas: up to 1 per service");
    expect(text).toContain("Card: visa •••• 4242");
    expect(text).toContain("Billing: https://lizard.build/profile/account-billing");
    expect(err()).not.toContain("lizard credits");
  });

  test("a paid month shows $X of $19 used and the overage", async () => {
    routes({ "GET /api/billing/subscription": () => reply(200, paid) });
    await run(["billing", "status"]);
    const text = out();
    expect(text).toContain("Pro  active");
    expect(text).toContain("This month: $31.40 of $19 used");
    expect(text).toContain("Overage: $12.40 this month, $0 invoiced so far; the next invoice goes out at $20");
    expect(text).toMatch(/Next charge: \$31\.40 on/);
  });

  test("cancelling and past due are spelled out", async () => {
    routes({
      "GET /api/billing/subscription": () => reply(200, {
        ...paid, status: "past_due", cancelAt: now + 20 * DAY, nextCharge: null, pastDue: true,
        openInvoiceUrl: "https://invoice.stripe.com/i/x",
      }),
    });
    await run(["billing"]);
    const text = out();
    expect(text).toContain("Pro  past due");
    expect(text).toMatch(/Ends on \w{3} \d+, \d{4}\. Run lizard billing resume to keep Pro\./);
    expect(text).toContain("A payment failed.");
    expect(text).toContain("Pay it: https://invoice.stripe.com/i/x");
    expect(text).not.toContain("Next charge");
  });

  test("no plan offers the trial", async () => {
    routes({ "GET /api/billing/subscription": () => reply(200, { ...none, trial: { ...none.trial, promoCode: "ROST", days: 31, creditCents: 10000 } }) });
    await run(["billing"]);
    const text = out();
    expect(text).toContain("No plan");
    expect(text).toContain("Start a 31-day Pro trial with $100 in credits: lizard billing start");
    expect(text).toContain("No charge today, then $19/month, taxes included.");
    expect(text).toContain("Promo code: ROST");
  });

  test("no plan and the trial used offers Pro", async () => {
    routes({ "GET /api/billing/subscription": () => reply(200, { ...none, status: "canceled", trial: { ...none.trial, eligible: false } }) });
    await run(["billing"]);
    expect(out()).toContain("Pro has ended.");
    expect(out()).toContain("Start Pro: $19/month, taxes included, with $19 in credits each month: lizard billing start");
  });

  test("enterprise is invoiced monthly", async () => {
    routes({ "GET /api/billing/subscription": () => reply(200, { ...none, plan: "enterprise" }) });
    await run(["billing"]);
    expect(out()).toContain("Enterprise");
    expect(out()).toContain("Pay as you go, invoiced monthly.");
  });

  test("old prepaid credits keep the balance view and say when credits end", async () => {
    routes({
      "GET /api/billing/subscription": () => reply(200, { ...none, plan: "payg" }),
      "GET /api/billing/balance": () => reply(200, balance),
    });
    await run(["billing"]);
    const text = out();
    expect(text).toContain("$12.34  active  (payg)");
    expect(text).toContain("Available before freeze: $13.34");
    expect(text).toContain("Prepaid credits end on November 1, 2026. Start Pro before then: lizard billing start");
    expect(text).toContain("Billing: https://lizard.build/profile/account-billing");
  });

  test("--json prints the plan with the Billing link, and the balance for prepaid credits", async () => {
    setJSONMode(true);
    routes({
      "GET /api/billing/subscription": () => reply(200, { ...none, plan: "payg" }),
      "GET /api/billing/balance": () => reply(200, balance),
    });
    await run(["billing"]);
    const json = JSON.parse(stdout.join("\n"));
    expect(json.plan).toBe("payg");
    expect(json.billingUrl).toBe("https://lizard.build/profile/account-billing");
    expect(json.balance.balanceCents).toBe(1234);
    expect(json.notice).toBe("Prepaid credits end on November 1, 2026.");
  });

  test("a server without Pro falls back to the balance view", async () => {
    routes({ "GET /api/billing/balance": () => reply(200, balance) });
    await run(["billing"]);
    expect(out()).toContain("$12.34  active  (payg)");
    expect(out()).not.toContain("November 1");
  });

  test("-w reads the workspace owner's plan, before or after the subcommand", async () => {
    routes({ "GET /api/billing/subscription?workspaceId=ws_1": () => reply(200, { ...paid, isOwner: false, paymentMethod: null }) });
    await run(["billing", "status", "-w", "ws_1"]);
    await run(["billing", "-w", "ws_1"]);
    expect(calls().map((c) => c.key)).toEqual([
      "GET /api/billing/subscription?workspaceId=ws_1",
      "GET /api/billing/subscription?workspaceId=ws_1",
    ]);
    expect(out()).toContain("(workspace owner's plan)");
  });

  test("`lizard credits` still works and says it is now `lizard billing`", async () => {
    routes({ "GET /api/billing/subscription": () => reply(200, base) });
    await run(["credits"]);
    expect(out()).toContain("Pro  trial");
    expect(err()).toContain("`lizard credits` is now `lizard billing`");
  });
});

describe("lizard billing actions", () => {
  test("open prints the Billing page", async () => {
    await run(["billing", "open", "--no-open"]);
    expect(out()).toBe("https://lizard.build/profile/account-billing");
    setJSONMode(true);
    stdout = [];
    await run(["billing", "open"]);
    expect(JSON.parse(stdout.join("\n"))).toEqual({ url: "https://lizard.build/profile/account-billing", opened: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("start opens Checkout for the trial", async () => {
    routes({
      "POST /api/billing/subscription/checkout": () => reply(200, {
        url: "https://checkout.stripe.com/c/pay/cs_1", sessionId: "cs_1", trialDays: 7, trialCreditCents: 500,
      }),
    });
    await run(["billing", "start", "--return-url", "/projects/abc", "--no-open"]);
    expect(calls()).toEqual([{ key: "POST /api/billing/subscription/checkout", body: { returnUrl: "/projects/abc" } }]);
    expect(out()).toContain("Your 7-day trial includes $5 in credits. No charge today, then $19/month, taxes included.");
    expect(out()).toContain("https://checkout.stripe.com/c/pay/cs_1");
  });

  test("start without a trial says Pro starts today; --json prints the session", async () => {
    const session = { url: "https://checkout.stripe.com/c/pay/cs_2", sessionId: "cs_2", trialDays: null, trialCreditCents: null };
    routes({ "POST /api/billing/subscription/checkout": () => reply(200, session) });
    await run(["billing", "start", "--no-open"]);
    expect(out()).toContain("Pro starts today: $19/month, taxes included, with $19 in credits each month.");
    setJSONMode(true);
    stdout = [];
    await run(["billing", "start"]);
    expect(JSON.parse(stdout.join("\n"))).toEqual(session);
  });

  test("start passes the platform's refusal through", async () => {
    routes({
      "POST /api/billing/subscription/checkout": () => reply(409, { error: "ALREADY_SUBSCRIBED", message: "This account already has Pro" }),
    });
    await expect(run(["billing", "start"])).rejects.toMatchObject({ status: 409, code: "ALREADY_SUBSCRIBED", message: "This account already has Pro" });
  });

  test("start-now needs -y without a terminal", async () => {
    await expect(run(["billing", "start-now"])).rejects.toThrow("Use -y to confirm");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("start-now charges and reports each outcome", async () => {
    routes({ "POST /api/billing/subscription/start-now": () => reply(200, { status: "active" }) });
    await run(["billing", "start-now", "-y"]);
    expect(err()).toContain("Pro is active. We charged $19 and added $19 in credits for this month.");

    routes({ "POST /api/billing/subscription/start-now": () => reply(200, { status: "requires_action", invoiceUrl: "https://invoice.stripe.com/i/3ds" }) });
    await run(["billing", "start-now", "-y", "--no-open"]);
    expect(out()).toContain("Your bank needs you to confirm the payment.");
    expect(out()).toContain("https://invoice.stripe.com/i/3ds");

    routes({ "POST /api/billing/subscription/start-now": () => reply(200, { status: "failed" }) });
    await expect(run(["billing", "start-now", "-y"])).rejects.toMatchObject({ code: "PAYMENT_FAILED" });
  });

  test("cancel and resume", async () => {
    const cancelAt = Date.UTC(2026, 10, 5, 12);
    routes({
      "POST /api/billing/subscription/cancel": () => reply(200, { cancelAt }),
      "POST /api/billing/subscription/resume": () => reply(200, { cancelAt: null }),
    });
    await expect(run(["billing", "cancel"])).rejects.toThrow("Use -y to confirm");
    await run(["billing", "cancel", "-y"]);
    expect(err()).toContain("Pro ends on Nov 5, 2026. Run `lizard billing resume` to keep it.");
    await run(["billing", "resume"]);
    expect(err()).toContain("Pro continues.");
    expect(calls().map((c) => c.key)).toEqual(["POST /api/billing/subscription/cancel", "POST /api/billing/subscription/resume"]);
  });

  test("promo prints the trial it gives", async () => {
    routes({
      "POST /api/billing/promo/redeem": () => reply(200, {
        status: "pending_payment_method", code: "ROST", creditCents: 10000, expiresAt: null, balanceCents: 0,
        trialDays: 31, trialCreditCents: 10000, appliesTo: "next_checkout",
      }),
    });
    await run(["billing", "promo", "ROST"]);
    expect(calls()).toEqual([{ key: "POST /api/billing/promo/redeem", body: { code: "ROST" } }]);
    expect(err()).toContain("Code ROST saved: a 31-day Pro trial with $100 in credits. Start it with `lizard billing start`.");
  });

  test("promo errors keep their code", async () => {
    routes({ "POST /api/billing/promo/redeem": () => reply(400, { error: "PROMO_TRIAL_ONLY", message: "Promo codes work only before your first payment" }) });
    await expect(run(["billing", "promo", "LATE"])).rejects.toMatchObject({ code: "PROMO_TRIAL_ONLY", message: "Promo codes work only before your first payment" });
  });

  test("removed commands are gone", async () => {
    for (const args of [["billing", "topup", "20"], ["billing", "auto-topup"], ["billing", "payment-status", "a1"]]) {
      await expect(run(args)).rejects.toMatchObject({ code: "commander.excessArguments" });
    }
    await expect(run(["billing", "payment-methods", "add"])).rejects.toMatchObject({ code: "commander.unknownCommand" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("describePromo", () => {
  test("a code applied to the running trial", () => {
    expect(describePromo({
      status: "applied", code: "ROST", creditCents: 10000, expiresAt: Date.UTC(2026, 10, 7, 12), balanceCents: 0,
      trialDays: 31, trialCreditCents: 10000, appliesTo: "current_trial",
    })).toBe("Your trial now runs 31 days with $100 in credits, until Nov 7, 2026.");
  });

  test("an older server's answers", () => {
    expect(describePromo({ status: "applied", creditCents: 2500, expiresAt: null, balanceCents: 3000 }))
      .toBe("Redeemed $25.00. New balance: $30.00.");
    expect(describePromo({ status: "pending_payment_method", creditCents: 2500, expiresAt: null, balanceCents: 0 }))
      .toBe("Code saved: $25.00 in credits. They unlock when you start your trial in Billing.");
  });
});
