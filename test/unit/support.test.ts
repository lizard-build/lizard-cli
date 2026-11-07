import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isPlatformFailure, printSupportInbox, recordFailedCall, ticketContext } from "../../src/lib/support.js";

let home: string;
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), "lz-support-")); process.env.LIZARD_HOME = home; });
afterEach(() => { delete process.env.LIZARD_HOME; fs.rmSync(home, { recursive: true, force: true }); vi.restoreAllMocks(); });

const unread = { tickets: [{ ticket: "T-1043", subject: "eu create 500", status: "answered", messages: [{ from: "Lizard support (Mike)", body: "Which region?", at: "2026-11-07T18:00:00.000Z" }] }] };

describe("support inbox", () => {
  it("prints a reply on stderr at most twice, never on stdout", async () => {
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const fetch = vi.fn(async () => unread);
    for (let i = 0; i < 3; i++) await printSupportInbox(fetch, { force: true });
    const shown = err.mock.calls.map((c) => String(c[0])).filter((s) => s.includes("Which region?"));
    expect(shown).toHaveLength(2);
    expect(shown[0]).toContain("lizard support reply T-1043");
    expect(out).not.toHaveBeenCalled();
  });
  it("checks at most once a minute", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const fetch = vi.fn(async () => ({ tickets: [] }));
    await printSupportInbox(fetch);
    await printSupportInbox(fetch);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("never throws when the platform fails", async () => {
    await expect(printSupportInbox(async () => { throw new Error("down"); }, { force: true })).resolves.toBeUndefined();
  });
});

describe("ticket context", () => {
  it("attaches recent failures with keys redacted", () => {
    recordFailedCall("POST", "/api/sandboxes?workspaceId=w1", 500, "boom liz_abcdefghijkl123");
    const ctx = ticketContext() as any;
    expect(ctx.lastErrors).toHaveLength(1);
    expect(ctx.lastErrors[0]).toMatchObject({ method: "POST", path: "/api/sandboxes", status: 500 });
    expect(ctx.lastErrors[0].error).not.toContain("abcdefghijkl");
    expect(ctx.cliVersion).toBeTruthy();
  });
  it("treats only platform-side failures as ticket-worthy", () => {
    expect(isPlatformFailure(500)).toBe(true);
    expect(isPlatformFailure(504)).toBe(true);
    expect(isPlatformFailure(404)).toBe(false);
    expect(isPlatformFailure(402)).toBe(false);
    expect(isPlatformFailure(undefined, "ECONNRESET")).toBe(true);
  });
});
