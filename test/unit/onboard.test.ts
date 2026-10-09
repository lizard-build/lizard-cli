import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Command } from "commander";
import {
  registerOnboard,
  accountState,
  accountInstruction,
  loginPendingEvent,
  nextSteps,
} from "../../src/commands/onboard.js";
import { authUrlFor, providerFlag } from "../../src/commands/login.js";
import type { Subscription } from "../../src/commands/billing.js";
import { setBaseURL } from "../../src/lib/api.js";
import { setJSONMode } from "../../src/lib/format.js";
import { loadConfig, saveConfig } from "../../src/lib/config.js";

const fetchMock = vi.fn();
let stdout: string[];
let tmpDir: string;
const savedEnv: Record<string, string | undefined> = {};

function reply(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** Answers each request by "METHOD path". */
function routes(table: Record<string, () => Response>) {
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${new URL(url).pathname}`;
    const handler = table[key];
    if (!handler) return reply(404, { error: `no route ${key}` });
    return handler();
  });
}

function requested(): string[] {
  return fetchMock.mock.calls.map(([url, init]) => `${init?.method ?? "GET"} ${new URL(url).pathname}`);
}

/** The JSON lines the command wrote. */
function events(): Array<Record<string, any>> {
  return stdout.join("").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function run(args: string[]) {
  const program = new Command().exitOverride().configureOutput({ writeErr: () => {}, writeOut: () => {} });
  registerOnboard(program);
  return program.parseAsync(args, { from: "user" });
}

/** An unsigned JWT that expires `inMs` from now: enough for the CLI's expiry check. */
function jwt(inMs: number) {
  const part = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${part({ alg: "none" })}.${part({ exp: Math.floor((Date.now() + inMs) / 1000) })}.sig`;
}

const DAY = 86_400_000;

const none: Subscription = {
  plan: "none",
  status: "none",
  isOwner: true,
  priceCents: 1900,
  taxIncluded: true,
  includedCents: 1900,
  trial: { eligible: true, days: 7, creditCents: 500, promoCode: null, endsAt: null, usedCents: null, remainingCents: null },
  period: null,
  nextCharge: null,
  cancelAt: null,
  pastDue: false,
  openInvoiceUrl: null,
  paymentMethod: null,
  limits: null,
  checkoutAvailable: true,
};

const session = { sessionId: "sess123", sessionSecret: "secret456", expiresIn: 300 };
const me = { id: "u1", username: "ada", email: "ada@example.com" };

beforeEach(() => {
  for (const k of ["LIZARD_HOME", "LIZARD_TOKEN", "LIZARD_API_KEY"]) savedEnv[k] = process.env[k];
  delete process.env.LIZARD_TOKEN;
  delete process.env.LIZARD_API_KEY;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lizard-onboard-test-"));
  process.env.LIZARD_HOME = tmpDir;

  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  setBaseURL("https://lizard.build");
  setJSONMode(true);
  stdout = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: any) => { stdout.push(String(chunk)); return true; });
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setJSONMode(false);
  process.exitCode = undefined;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("sign-in links", () => {
  test("without a provider the link is the one older CLIs open", () => {
    expect(authUrlFor("abc")).toBe("https://lizard.build/auth/cli?session=abc");
    expect(authUrlFor("abc", "google")).toBe("https://lizard.build/auth/cli?session=abc&provider=google");
  });

  test("--github and --google together are refused", () => {
    expect(providerFlag({})).toBeUndefined();
    expect(providerFlag({ google: true })).toBe("google");
    expect(() => providerFlag({ github: true, google: true })).toThrow(/not both/);
  });

  test("with two methods the agent gets both links and the same-method rule", () => {
    const ev = loginPendingEvent({ sessionId: "s", sessionSecret: "x", expiresAt: Date.now() + 300_000 }, ["github", "google"], "new");
    expect(ev.authUrl).toBeUndefined();
    expect(ev.authUrls).toEqual({
      github: "https://lizard.build/auth/cli?session=s&provider=github",
      google: "https://lizard.build/auth/cli?session=s&provider=google",
    });
    expect(ev.nextCommand).toBe("lizard onboard");
    expect(ev.instruction).toContain("same method as before");
    expect(ev.instruction).toContain("5 more minutes");
  });

  test("a chosen method gives one link and keeps the flag in nextCommand", () => {
    const ev = loginPendingEvent({ sessionId: "s", sessionSecret: "x", expiresAt: Date.now() + 60_000 }, ["google"], "expired", "google");
    expect(ev.authUrl).toBe("https://lizard.build/auth/cli?session=s&provider=google");
    expect(ev.nextCommand).toBe("lizard onboard --google");
    expect(ev.instruction).toMatch(/^The last sign-in link expired/);
    expect(ev.instruction).toContain("1 more minute;");
  });
});

describe("account state", () => {
  test("maps the subscription to what the account still needs", () => {
    expect(accountState(null)).toBe("unknown");
    expect(accountState(none)).toBe("trial_available");
    expect(accountState({ ...none, trial: { ...none.trial, eligible: false } })).toBe("subscription_required");
    expect(accountState({ ...none, checkoutAvailable: false })).toBe("checkout_unavailable");
    expect(accountState({ ...none, isOwner: false })).toBe("not_owner");
    expect(accountState({ ...none, plan: "payg" })).toBe("credits");
    expect(accountState({ ...none, plan: "enterprise" })).toBe("enterprise");
    expect(accountState({ ...none, plan: "pro", status: "trialing" })).toBe("trialing");
    expect(accountState({ ...none, plan: "pro", status: "active" })).toBe("active");
    expect(accountState({ ...none, plan: "pro", status: "active", pastDue: true })).toBe("past_due");
  });

  test("instructions say when not to touch billing", () => {
    expect(accountInstruction("trial_available", none)).toContain("7-day Pro trial with $5 in credits");
    expect(accountInstruction("trial_available", none)).toContain("lizard billing start --json");
    expect(accountInstruction("subscription_required", none)).toContain("do NOT promise one");
    expect(accountInstruction("active", null)).toContain("Do NOT open billing");
    expect(accountInstruction("unknown", null)).toContain("Do NOT start billing");
    const now = Date.now();
    const trialing = { ...none, plan: "pro", status: "trialing", trial: { ...none.trial, endsAt: now + 3 * DAY, remainingCents: 380 } };
    expect(accountInstruction("trialing", trialing, now)).toBe(
      "The Pro trial is on (3 days left, $3.80 of trial credits left). Do NOT open billing or start a subscription.",
    );
  });

  test("an unlinked folder gets lizard init before lizard up", () => {
    expect(nextSteps(false).map((s) => s.command)).toEqual(["lizard skills get core", "lizard init", "lizard up"]);
    expect(nextSteps(true).map((s) => s.command)).toEqual(["lizard skills get core", "lizard up"]);
  });
});

describe("lizard onboard --json", () => {
  test("signed out: starts a session, saves it, prints the links and exits", async () => {
    routes({
      "POST /api/auth/cli/session": () => reply(200, session),
      "GET /api/auth/providers": () => reply(200, { github: true, google: true }),
    });
    await run(["onboard"]);

    const [pending, done] = events();
    expect(pending.event).toBe("login_pending");
    expect(Object.keys(pending.authUrls)).toEqual(["github", "google"]);
    expect(pending.nextCommand).toBe("lizard onboard");
    expect(done).toEqual({ event: "done", signedIn: false });

    const saved = loadConfig().pendingAuth!;
    expect(saved.sessionId).toBe("sess123");
    expect(saved.expiresAt).toBeGreaterThan(Date.now());
    expect(requested()).not.toContain("POST /api/auth/cli/poll");
  });

  test("--google prints one Google link and no provider list request", async () => {
    routes({ "POST /api/auth/cli/session": () => reply(200, session) });
    await run(["onboard", "--google"]);
    const [pending] = events();
    expect(pending.authUrl).toBe("https://lizard.build/auth/cli?session=sess123&provider=google");
    expect(pending.nextCommand).toBe("lizard onboard --google");
    expect(requested()).toEqual(["POST /api/auth/cli/session"]);
  });

  test("the next run finishes an approved session and reports the plan", async () => {
    saveConfig({
      pendingAuth: { sessionId: "sess123", sessionSecret: "secret456", authUrl: "x", createdAt: Date.now() },
    });
    routes({
      "POST /api/auth/cli/poll": () => reply(200, { status: "complete", accessToken: jwt(DAY), user: { id: "u1", username: "ada" } }),
      "GET /api/auth/me": () => reply(200, me),
      "GET /api/billing/subscription": () => reply(200, none),
    });
    await run(["onboard"]);

    const [signedIn, account, done] = events();
    expect(signedIn).toEqual({ event: "signed_in", username: "ada", email: "ada@example.com", source: "browser" });
    expect(account.event).toBe("account");
    expect(account.state).toBe("trial_available");
    expect(account.billingUrl).toBe("https://lizard.build/profile/account-billing");
    expect(account.next.map((s: { command: string }) => s.command)).toContain("lizard init");
    expect(done).toEqual({ event: "done", signedIn: true });

    const config = loadConfig();
    expect(config.pendingAuth).toBeUndefined();
    expect(config.credentials?.username).toBe("ada");
  });

  test("a session the browser has not approved yet keeps its links", async () => {
    saveConfig({
      pendingAuth: { sessionId: "sess123", sessionSecret: "secret456", authUrl: "x", createdAt: Date.now() },
    });
    routes({
      "POST /api/auth/cli/poll": () => reply(200, { status: "pending" }),
      "GET /api/auth/providers": () => reply(200, { github: true, google: false }),
    });
    await run(["onboard"]);

    const [pending] = events();
    expect(pending.authUrl).toBe("https://lizard.build/auth/cli?session=sess123&provider=github");
    expect(pending.instruction).toMatch(/^The user has not finished signing in yet/);
    expect(requested()).not.toContain("POST /api/auth/cli/session");
  });

  test("an expired session is replaced by a new one", async () => {
    saveConfig({
      pendingAuth: { sessionId: "old", sessionSecret: "s", authUrl: "x", createdAt: Date.now() - 10 * 60_000 },
    });
    routes({
      "POST /api/auth/cli/poll": () => reply(200, { status: "expired" }),
      "POST /api/auth/cli/session": () => reply(200, session),
      "GET /api/auth/providers": () => reply(200, { github: true, google: true }),
    });
    await run(["onboard"]);

    const [pending] = events();
    expect(pending.authUrls.github).toContain("session=sess123");
    expect(pending.instruction).toMatch(/^The last sign-in link expired/);
    expect(loadConfig().pendingAuth?.sessionId).toBe("sess123");
  });

  test("a saved login skips sign-in", async () => {
    saveConfig({ credentials: { accessToken: jwt(DAY), userId: "u1", username: "ada" } });
    routes({
      "GET /api/auth/me": () => reply(200, me),
      "GET /api/billing/subscription": () => reply(200, { ...none, plan: "pro", status: "active" }),
    });
    await run(["onboard"]);

    const [signedIn, account] = events();
    expect(signedIn.source).toBe("saved");
    expect(account.state).toBe("active");
    expect(requested()).toEqual(["GET /api/auth/me", "GET /api/billing/subscription"]);
  });

  test("a saved token the platform rejects is dropped and sign-in starts", async () => {
    saveConfig({ credentials: { accessToken: jwt(DAY), userId: "u1", username: "ada" } });
    routes({
      "GET /api/auth/me": () => reply(401, { error: "Unauthorized" }),
      "POST /api/auth/cli/session": () => reply(200, session),
      "GET /api/auth/providers": () => reply(200, { github: true, google: true }),
    });
    await run(["onboard"]);

    expect(events()[0].event).toBe("login_pending");
    expect(loadConfig().credentials).toBeUndefined();
  });

  test("a token from the environment counts as signed in, and a plan it cannot read is unknown", async () => {
    process.env.LIZARD_API_KEY = "liz_scoped";
    routes({
      "GET /api/auth/me": () => reply(200, { id: "u1", username: "ada", scoped: true }),
      "GET /api/billing/subscription": () => reply(403, { error: "ACCOUNT_SCOPE_REQUIRED", message: "no" }),
    });
    await run(["onboard"]);

    const [signedIn, account] = events();
    expect(signedIn).toEqual({ event: "signed_in", username: "ada", scoped: true, source: "env" });
    expect(account.state).toBe("unknown");
    expect(account.instruction).toContain("Do NOT start billing");
  });

  test("a rejected environment token ends in an error event", async () => {
    process.env.LIZARD_TOKEN = "bad";
    routes({ "GET /api/auth/me": () => reply(401, { error: "Invalid token" }) });
    await run(["onboard"]);

    expect(events()).toEqual([{ event: "error", code: "ERROR", message: "Invalid token" }]);
    expect(process.exitCode).toBe(2);
  });
});
