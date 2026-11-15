import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveCheckout, sha256, sync, type Checkout } from "../../src/lib/checkout.js";

// A fake Lizard Git that serves one changeset: `tree` maps paths to contents (a symlink is
// { link: target }). Trees are addressed by a made-up hash, blobs by their sha256.
function serve(tree: Record<string, string | { link: string }>, older: string[] = []) {
  const trees: Record<string, any[]> = {};
  const blobs: Record<string, string> = {};
  for (const b of older) blobs[sha256(b)] = Buffer.from(b).toString("base64"); // contents of the base changeset
  let n = 0;
  const build = (prefix: string): string => {
    const names = new Set<string>();
    for (const p of Object.keys(tree)) if (p.startsWith(prefix)) names.add(p.slice(prefix.length).split("/")[0]);
    const entries = [...names].sort().map((name) => {
      const full = prefix + name;
      const v = tree[full];
      if (v === undefined) return { name, mode: "040000", type: "tree", hash: build(full + "/"), size: 0 };
      const body = typeof v === "string" ? v : v.link;
      const h = sha256(body);
      blobs[h] = Buffer.from(body).toString("base64");
      return { name, mode: typeof v === "string" ? "100644" : "120000", type: "blob", hash: h, size: body.length };
    });
    const h = `tree${n++}`.padEnd(64, "0");
    trees[h] = entries;
    return h;
  };
  const root = build("");
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: any) => {
    if (url.includes("/resolve")) return new Response(JSON.stringify({ id: "c".repeat(64), root }), { status: 200 });
    if (url.endsWith("/objects")) {
      const req = JSON.parse(init.body);
      const out = { trees: {} as any, blobs: {} as any, fetchSeparately: [] };
      for (const h of req.trees) out.trees[h] = trees[h];
      for (const h of req.blobs) out.blobs[h] = blobs[h];
      return new Response(JSON.stringify(out), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  }));
}

let outside: string;
let root: string;
beforeEach(() => {
  vi.stubEnv("LIZARD_GIT_CACHE", mkdtempSync(join(tmpdir(), "lzg-cache-")));
  vi.stubEnv("LIZARD_TOKEN", "liz_test");
  outside = mkdtempSync(join(tmpdir(), "lzg-outside-"));
  root = mkdtempSync(join(tmpdir(), "lzg-root-"));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const checkout = (files: Checkout["files"]): Checkout => {
  const c: Checkout = { version: 1, url: "x", repo: "alice/app", branch: "main", base: "b".repeat(64), root: "r".repeat(64), sparse: null, files };
  saveCheckout(root, c);
  return c;
};

describe("lizard git sync never writes through a symlink", () => {
  it("a deleted symlink is gone before a file is written under its name", async () => {
    symlinkSync(outside, join(root, "d"));
    const c = checkout({ d: { h: sha256(outside), m: "120000" } });
    serve({ "d/authorized_keys": "attacker key" });
    await sync(root, c);
    expect(existsSync(join(outside, "authorized_keys"))).toBe(false);
    expect(lstatSync(join(root, "d")).isDirectory()).toBe(true);
    expect(readFileSync(join(root, "d/authorized_keys"), "utf8")).toBe("attacker key");
  });

  it("a symlinked folder that stays (changed here) refuses the file instead", async () => {
    symlinkSync(outside, join(root, "d")); // tracked with another target: a local change
    const c = checkout({ d: { h: sha256("elsewhere"), m: "120000" } });
    serve({ "d/x": "payload" }, ["elsewhere"]);
    const r = await sync(root, c);
    expect(existsSync(join(outside, "x"))).toBe(false);
    expect(r.conflicts?.map((x) => x.path)).toContain("d/x");
    expect(c.files["d/x"]).toBeUndefined();
  });

  it("a folder replaced by a symlink: the folder's files are removed here, not where the link points", async () => {
    mkdirSync(join(root, "d"));
    writeFileSync(join(root, "d/authorized_keys"), "mine");
    writeFileSync(join(outside, "authorized_keys"), "victim");
    const c = checkout({ "d/authorized_keys": { h: sha256("mine"), m: "100644" } });
    serve({ d: { link: outside } });
    await sync(root, c);
    expect(readFileSync(join(outside, "authorized_keys"), "utf8")).toBe("victim");
    expect(lstatSync(join(root, "d")).isSymbolicLink()).toBe(true);
  });

  it("a new symlink in the changeset is created as a link, nothing goes through it", async () => {
    const c = checkout({});
    serve({ d: { link: outside }, "e/x": "ok" });
    await sync(root, c);
    // the link itself is fine to create; nothing was written through it
    expect(lstatSync(join(root, "d")).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(root, "e/x"), "utf8")).toBe("ok");
  });
});
