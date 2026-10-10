import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Command } from "commander";
import { Readable } from "node:stream";
import { registerLogin, accountState, accountInstruction, nextSteps, nextStepsNote, readTokenFromStdin } from "../../src/commands/login.js";
import { authUrlFor, providerFlag, pendingPayload } from "../../src/lib/signin.js";
import type { Subscription } from "../../src/commands/billing.js";
import { requireAuth } from "../../src/lib/auth.js";
import { APIError, setBaseURL } from "../../src/lib/api.js";
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

/** The one JSON object `lizard login --json` printed. */
function output(): Record<string, any> {
  return JSON.parse(stdout.join("\n"));
}

function run(args: string[]) {
  const program = new Command().exitOverride().configureOutput({ writeErr: () => {}, writeOut: () => {} });
  registerLogin(program);
  return program.parseAsync(args, { from: "user" });
}

/** An unsigned JWT that expires `inMs` from now: enough for the CLI's expiry check. */
function jwt(inMs: number) {
  const part = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${part({ alg: "none" })}.${part({ exp: Math.floor((Date.now() + inMs) / 1000) })}.sig`;
}

async function authError(): Promise<APIError> {
  try {
    await requireAuth();
  } catch (err) {
    return err as APIError;
  }
  throw new Error("requireAuth did not throw");
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
const both = () => reply(200, { github: true, google: true });

function savePending(createdAt = Date.now()) {
  saveConfig({ pendingAuth: { sessionId: "sess123", sessionSecret: "secret456", authUrl: "x", createdAt } });
}

beforeEach(() => {
  for (const k of ["LIZARD_HOME", "LIZARD_TOKEN", "LIZARD_API_KEY", "CI"]) savedEnv[k] = process.env[k];
  delete process.env.LIZARD_TOKEN;
  delete process.env.LIZARD_API_KEY;
  delete process.env.CI;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lizard-login-test-"));
  process.env.LIZARD_HOME = tmpDir;

  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  setBaseURL("https://lizard.build");
  setJSONMode(true);
  stdout = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { stdout.push(a.join(" ")); });
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setJSONMode(false);
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

  test("two methods: both links, the old authUrl, and the same-method rule", () => {
    const ev = pendingPayload({ sessionId: "s", sessionSecret: "x", expiresAt: Date.now() + 300_000 }, ["github", "google"], "new");
    expect(ev.status).toBe("pending");
    expect(ev.authUrl).toBe("https://lizard.build/auth/cli?session=s");
    expect(ev.authUrls).toEqual({
      github: "https://lizard.build/auth/cli?session=s&provider=github",
      google: "https://lizard.build/auth/cli?session=s&provider=google",
    });
    expect(ev).not.toHaveProperty("nextCommand");
    expect(ev.instruction).toContain("same method as before");
    expect(ev.instruction).toContain("run the same command again");
    expect(ev.instruction).toContain("5 more minutes");
  });

  test("a chosen method: one link, and nextCommand keeps the flag", () => {
    const ev = pendingPayload(
      { sessionId: "s", sessionSecret: "x", expiresAt: Date.now() + 60_000 },
      ["google"],
      "expired",
      { flag: "google", nextCommand: "lizard login --google" },
    );
    expect(ev.authUrl).toBe("https://lizard.build/auth/cli?session=s&provider=google");
    expect(ev.nextCommand).toBe("lizard login --google");
    expect(ev.instruction).toMatch(/^The last sign-in link expired/);
    expect(ev.instruction).toContain("run nextCommand");
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

  test("the closing note leads with sandboxes, aligned in two columns", () => {
    const plain = (t: string) => t.replace(/\x1b\[[0-9;]*m/g, "");
    expect(plain(nextStepsNote()).split("\n")).toEqual([
      "lizard sandbox create   Start a sandbox",
      "lizard up               Or deploy this folder",
    ]);
  });

  test("no lizard init needed: an unlinked folder uses the default project", () => {
    expect(nextSteps(false).map((s) => s.command)).toEqual(["lizard skills get core", "lizard sandbox create", "lizard up"]);
    expect(nextSteps(false)[1].why).toContain("default project");
    expect(nextSteps(true).map((s) => s.command)).toEqual(["lizard skills get core", "lizard sandbox create", "lizard up"]);
    expect(nextSteps(true)[1].why).toContain("linked project");
  });
});

describe("lizard login --json", () => {
  test("signed out: saves a session and prints the links as one object", async () => {
    routes({ "POST /api/auth/cli/session": () => reply(200, session), "GET /api/auth/providers": both });
    await run(["login"]);

    const out = output();
    expect(out.status).toBe("pending");
    expect(out.authUrl).toBe("https://lizard.build/auth/cli?session=sess123");
    expect(Object.keys(out.authUrls)).toEqual(["github", "google"]);
    expect(out.nextCommand).toBe("lizard login");
    const saved = loadConfig().pendingAuth!;
    expect(saved.sessionId).toBe("sess123");
    expect(saved.expiresAt).toBeGreaterThan(Date.now());
  });

  test("--google prints one Google link without asking which methods exist", async () => {
    routes({ "POST /api/auth/cli/session": () => reply(200, session) });
    await run(["login", "--google"]);
    expect(output().authUrl).toBe("https://lizard.build/auth/cli?session=sess123&provider=google");
    expect(output().nextCommand).toBe("lizard login --google");
    expect(requested()).toEqual(["POST /api/auth/cli/session"]);
  });

  test("the next run finishes an approved session and reports the plan", async () => {
    savePending();
    routes({
      "POST /api/auth/cli/poll": () => reply(200, { status: "complete", accessToken: jwt(DAY), user: { id: "u1", username: "ada" } }),
      "GET /api/auth/me": () => reply(200, me),
      "GET /api/billing/subscription": () => reply(200, none),
    });
    await run(["login"]);

    const out = output();
    expect(out).toMatchObject({ status: "complete", username: "ada", email: "ada@example.com", source: "browser" });
    expect(out.account.state).toBe("trial_available");
    expect(out.account.billingUrl).toBe("https://lizard.build/profile/account-billing");
    expect(out.next.map((s: { command: string }) => s.command)).toContain("lizard sandbox create");
    expect(loadConfig().pendingAuth).toBeUndefined();
    expect(loadConfig().credentials?.username).toBe("ada");
  });

  test("a session the browser has not approved yet keeps its links", async () => {
    savePending();
    routes({
      "POST /api/auth/cli/poll": () => reply(200, { status: "pending" }),
      "GET /api/auth/providers": () => reply(200, { github: true, google: false }),
    });
    await run(["login"]);

    expect(output().authUrl).toBe("https://lizard.build/auth/cli?session=sess123&provider=github");
    expect(output().instruction).toMatch(/^The user has not finished signing in yet/);
    expect(requested()).not.toContain("POST /api/auth/cli/session");
  });

  test("an expired session is replaced by a new one", async () => {
    saveConfig({ pendingAuth: { sessionId: "old", sessionSecret: "s", authUrl: "x", createdAt: Date.now() - 10 * 60_000 } });
    routes({
      "POST /api/auth/cli/poll": () => reply(200, { status: "expired" }),
      "POST /api/auth/cli/session": () => reply(200, session),
      "GET /api/auth/providers": both,
    });
    await run(["login"]);

    expect(output().authUrls.github).toContain("session=sess123");
    expect(output().instruction).toMatch(/^The last sign-in link expired/);
    expect(loadConfig().pendingAuth?.sessionId).toBe("sess123");
  });

  test("a saved login is reported instead of starting a new one", async () => {
    saveConfig({ credentials: { accessToken: jwt(DAY), userId: "u1", username: "ada" } });
    routes({
      "GET /api/auth/me": () => reply(200, me),
      "GET /api/billing/subscription": () => reply(200, { ...none, plan: "pro", status: "active" }),
    });
    await run(["login"]);

    expect(output()).toMatchObject({ status: "complete", source: "saved", account: { state: "active" } });
    expect(requested()).toEqual(["GET /api/auth/me", "GET /api/billing/subscription"]);
  });

  test("a saved token the platform rejects is dropped and sign-in starts", async () => {
    saveConfig({ credentials: { accessToken: jwt(DAY), userId: "u1", username: "ada" } });
    routes({
      "GET /api/auth/me": () => reply(401, { error: "Unauthorized" }),
      "POST /api/auth/cli/session": () => reply(200, session),
      "GET /api/auth/providers": both,
    });
    await run(["login"]);

    expect(output().status).toBe("pending");
    expect(loadConfig().credentials).toBeUndefined();
  });

  test("a token from the environment counts, and a plan it cannot read is unknown", async () => {
    process.env.LIZARD_API_KEY = "liz_scoped";
    routes({
      "GET /api/auth/me": () => reply(200, { id: "u1", username: "ada", scoped: true }),
      "GET /api/billing/subscription": () => reply(403, { error: "ACCOUNT_SCOPE_REQUIRED", message: "no" }),
    });
    await run(["login"]);

    expect(output()).toMatchObject({ status: "complete", scoped: true, source: "env", account: { state: "unknown" } });
  });
});

describe("requireAuth without a terminal", () => {
  test("no login: fails with NOT_AUTHENTICATED and the sign-in links in the body", async () => {
    routes({ "POST /api/auth/cli/session": () => reply(200, session), "GET /api/auth/providers": both });
    const err = await authError();

    expect(err).toBeInstanceOf(APIError);
    expect(err.status).toBe(401);
    expect(err.code).toBe("NOT_AUTHENTICATED");
    expect(err.message).toMatch(/^Not signed in to Lizard\. Sign-in is needed/);
    const login = (err.body as { login: Record<string, any> }).login;
    expect(login.authUrls.google).toBe("https://lizard.build/auth/cli?session=sess123&provider=google");
    expect(login.instruction).toContain("run the same command again");
    expect(loadConfig().pendingAuth?.sessionId).toBe("sess123");
  });

  test("the same command run again picks up the approved session", async () => {
    savePending();
    routes({
      "POST /api/auth/cli/poll": () => reply(200, { status: "complete", accessToken: jwt(DAY), user: { id: "u1", username: "ada" } }),
    });
    const creds = await requireAuth();
    expect(creds.username).toBe("ada");
    expect(loadConfig().pendingAuth).toBeUndefined();
  });

  test("a session still waiting is handed out again, not replaced", async () => {
    savePending();
    routes({ "POST /api/auth/cli/poll": () => reply(200, { status: "pending" }), "GET /api/auth/providers": both });
    const err = await authError();

    expect(err.message).toContain("The user has not finished signing in yet");
    expect(requested()).not.toContain("POST /api/auth/cli/session");
  });

  test("an expired saved login says so", async () => {
    saveConfig({ credentials: { accessToken: jwt(-DAY), userId: "u1", username: "ada" } });
    routes({ "POST /api/auth/cli/session": () => reply(200, session), "GET /api/auth/providers": both });
    expect((await authError()).message).toMatch(/^The Lizard sign-in on this machine expired\./);
  });

  test("CI gets the plain error and no session", async () => {
    process.env.CI = "true";
    routes({});
    const err = await authError();
    expect(err.code).toBe("NOT_AUTHENTICATED");
    expect(err.body).toBeNull();
    expect(err.message).toContain("LIZARD_TOKEN");
    expect(requested()).toEqual([]);
  });

  test("a platform it cannot reach gives the plain error", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    const err = await authError();
    expect(err.code).toBe("NOT_AUTHENTICATED");
    expect(err.body).toBeNull();
  });

  test("a token in the environment skips all of it", async () => {
    process.env.LIZARD_TOKEN = "tok";
    expect((await requireAuth()).accessToken).toBe("tok");
    expect(requested()).toEqual([]);
  });
});

describe("lizard login with a token", () => {
  test("--token works as before: checks it, saves it, prints the username", async () => {
    routes({ "GET /api/auth/me": () => reply(200, me) });
    await run(["login", "--token", "tok_abc"]);

    expect(output()).toEqual({ status: "complete", username: "ada" });
    const [, init] = fetchMock.mock.calls[0];
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok_abc");
    expect(loadConfig().credentials).toMatchObject({ accessToken: "tok_abc", username: "ada", email: "ada@example.com" });
  });

  test("--token-stdin reads the piped token and does the same", async () => {
    vi.spyOn(process, "stdin", "get").mockReturnValue(Readable.from(["  tok_piped\n"]) as any);
    routes({ "GET /api/auth/me": () => reply(200, me) });
    await run(["login", "--token-stdin"]);

    expect(output()).toEqual({ status: "complete", username: "ada" });
    expect(loadConfig().credentials?.accessToken).toBe("tok_piped");
  });

  test("a rejected token is not saved", async () => {
    routes({ "GET /api/auth/me": () => reply(401, { error: "Unauthorized" }) });
    await expect(run(["login", "--token", "bad"])).rejects.toThrow("Invalid token");
    expect(loadConfig().credentials).toBeUndefined();
  });

  test("--token and --token-stdin together are refused", async () => {
    await expect(run(["login", "--token", "a", "--token-stdin"])).rejects.toThrow(/not both/);
    expect(requested()).toEqual([]);
  });

  test("stdin must be a pipe with something in it", async () => {
    const tty = Object.assign(Readable.from([]), { isTTY: true });
    await expect(readTokenFromStdin(tty)).rejects.toThrow(/piped token/);
    await expect(readTokenFromStdin(Readable.from(["\n  "]))).rejects.toThrow(/nothing on stdin/);
  });
});
