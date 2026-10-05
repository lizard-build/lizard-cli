import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, APIError, apiErrorFrom, errorLink, isPaymentRequired, setAccessToken, setBaseURL } from "../../src/lib/api.js";

const fetchMock = vi.fn();

function reply(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const proBody = {
  error: "INSUFFICIENT_CREDITS",
  code: "PAYMENT_REQUIRED",
  status: "trial_available",
  message: "Start your 7-day Pro trial with $5 in credits to deploy. No charge today, then $19/month.",
  subscribeUrl: "https://lizard.build/profile/account-billing?subscribe=1",
  billingUrl: "https://lizard.build/profile/account-billing",
  topupUrl: "https://lizard.build/profile/account-credits",
  balanceCents: 0,
  availableCents: 100,
};

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  setBaseURL("https://lizard.build");
  setAccessToken("test-token");
});
afterEach(() => vi.unstubAllGlobals());

describe("402 from a create path", () => {
  test("prints the platform's sentence and the trial link", async () => {
    fetchMock.mockResolvedValue(reply(402, proBody));
    const err = await api.post("/api/projects/p1/apps", {}).catch((e) => e);
    expect(err).toBeInstanceOf(APIError);
    expect(err.status).toBe(402);
    expect(err.code).toBe("PAYMENT_REQUIRED");
    expect(err.message).toBe(
      `${proBody.message}\n  Start your trial: ${proBody.subscribeUrl} (or run \`lizard billing start\`)`,
    );
    expect(err.body).toEqual(proBody);
    expect(isPaymentRequired(err)).toBe(true);
  });

  test("trial already used links Start Pro", () => {
    const err = apiErrorFrom(402, "Payment Required", {
      ...proBody, status: "subscription_required", message: "Start Pro ($19/month, taxes included) to deploy.",
    });
    expect(err.message).toBe(
      `Start Pro ($19/month, taxes included) to deploy.\n  Start Pro: ${proBody.subscribeUrl} (or run \`lizard billing start\`)`,
    );
  });

  test.each(["past_due", "paused"])("%s links Billing", (status) => {
    const err = apiErrorFrom(402, "Payment Required", { ...proBody, status, message: "A payment failed." });
    expect(err.message).toBe(`A payment failed.\n  Billing: ${proBody.billingUrl}`);
  });

  test("used trial credits link Billing and start-now", () => {
    const err = apiErrorFrom(402, "Payment Required", { ...proBody, status: "trial_credits_used", message: "Your trial credits are used up." });
    expect(err.message).toBe(
      `Your trial credits are used up.\n  Billing: ${proBody.billingUrl} (or run \`lizard billing start-now\`)`,
    );
  });

  test("old prepaid credits accounts link the Credits page", () => {
    const err = apiErrorFrom(402, "Payment Required", { ...proBody, status: "frozen", message: "Your credits are used up." });
    expect(err.message).toBe(`Your credits are used up.\n  Add credits: ${proBody.topupUrl}`);
  });

  test("an older server's body (no code, no billingUrl) still gets a link", () => {
    const old = {
      error: "INSUFFICIENT_CREDITS", status: "credits_required", message: "Add credits to keep deploying.",
      topupUrl: "https://lizard.build/profile/account-credits", balanceCents: 0, availableCents: 0,
    };
    const err = apiErrorFrom(402, "Payment Required", old);
    expect(err.code).toBe("INSUFFICIENT_CREDITS");
    expect(isPaymentRequired(err)).toBe(true);
    expect(err.message).toBe(`Add credits to keep deploying.\n  Add credits: ${old.topupUrl}`);
  });

  test("a code-only 402 body is recognized by code alone", () => {
    const err = apiErrorFrom(402, "Payment Required", { code: "PAYMENT_REQUIRED", message: "Start Pro.", billingUrl: proBody.billingUrl });
    expect(isPaymentRequired(err)).toBe(true);
    expect(err.message).toBe(`Start Pro.\n  Billing: ${proBody.billingUrl}`);
  });
});

describe("other errors with a link", () => {
  test("an unpaid invoice links the invoice", () => {
    const err = apiErrorFrom(402, "Payment Required", {
      error: "UNPAID_INVOICE", message: "Pay your open invoice before starting Pro again", invoiceUrl: "https://invoice.stripe.com/i/abc",
    });
    expect(err.code).toBe("UNPAID_INVOICE");
    expect(isPaymentRequired(err)).toBe(false);
    expect(err.message).toBe("Pay your open invoice before starting Pro again\n  Pay the open invoice: https://invoice.stripe.com/i/abc");
  });

  test("closed credits endpoints link Billing", () => {
    const err = apiErrorFrom(409, "Conflict", {
      error: "CREDITS_NOT_AVAILABLE", message: "Credits are replaced by the Pro plan. Open Billing to start Pro.", billingUrl: proBody.billingUrl,
    });
    expect(err.message).toBe(`Credits are replaced by the Pro plan. Open Billing to start Pro.\n  Billing: ${proBody.billingUrl}`);
  });

  test("plain errors are unchanged", () => {
    expect(apiErrorFrom(404, "Not Found", { error: "App not found" }).message).toBe("App not found");
    expect(apiErrorFrom(500, "Internal Server Error", null).message).toBe("Internal Server Error");
    expect(errorLink({ error: "x", billingUrl: "javascript:alert(1)" })).toBeNull();
  });
});
