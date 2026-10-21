import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { qs, gitURL, resolveRepo, lg, segs } from "../../src/lib/lizard-git.js";
import { changesOf, scanWorking, saveCheckout, findCheckout, sha256, unifiedDiff, type Checkout } from "../../src/lib/checkout.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("lizard git helpers", () => {
  it("drops empty query values", () => {
    expect(qs("/x", { a: "1", b: undefined, c: "", d: false, e: 2 })).toBe("/x?a=1&e=2");
  });

  it("honours LIZARD_GIT_URL", () => {
    vi.stubEnv("LIZARD_GIT_URL", "http://localhost:8080/");
    expect(gitURL()).toBe("http://localhost:8080");
  });

  it("takes owner/name or a bare name (yours) for --repo", async () => {
    vi.stubEnv("LIZARD_TOKEN", "liz_test");
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: any) => {
      calls.push(`${init.method} ${url} ${init.headers.Authorization}`);
      return new Response(JSON.stringify({ login: "me" }), { status: 200 });
    }));
    expect(await resolveRepo("alice/app")).toBe("alice/app");
    expect(await resolveRepo("app")).toBe("me/app");
    expect(calls).toEqual(["GET https://lizard.build/git/api/session Bearer liz_test"]);
    await expect(resolveRepo("a/b/c")).rejects.toThrow(/owner\/name/);
  });

  it("turns error bodies into APIError with the server's message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "no such repository" }), { status: 404 })));
    await expect(lg.get("/api/repos/a/b")).rejects.toMatchObject({ status: 404, message: "no such repository" });
  });
});

describe("lizard git safety", () => {
  it("refuses a LIZARD_GIT_URL that would send the sign-in in clear text", () => {
    vi.stubEnv("LIZARD_GIT_URL", "http://evil.example");
    expect(() => gitURL()).toThrow(/https/);
    vi.stubEnv("LIZARD_GIT_URL", "http://127.0.0.1:8080");
    expect(gitURL()).toBe("http://127.0.0.1:8080");
  });

  it("refuses . and .. in repository names and paths", async () => {
    await expect(resolveRepo("../x")).rejects.toThrow();
    await expect(resolveRepo("a/..")).rejects.toThrow();
    expect(() => segs("../../api/user/tokens")).toThrow(/bad path/);
    expect(segs("src/a b.js")).toBe("src/a%20b.js");
  });
});

describe("lizard git checkouts", () => {
  const make = (files: Record<string, string>, state: Partial<Checkout> = {}) => {
    const root = mkdtempSync(join(tmpdir(), "lzg-"));
    const c: Checkout = { version: 1, url: "x", repo: "alice/app", branch: "main", base: "b".repeat(64), root: "r".repeat(64), sparse: null, files: {}, ...state };
    for (const [p, body] of Object.entries(files)) {
      mkdirSync(join(root, p, ".."), { recursive: true });
      writeFileSync(join(root, p), body);
      c.files[p] = { h: sha256(body), m: "100644" };
    }
    saveCheckout(root, c);
    return { root, c };
  };

  it("finds its checkout from a subdirectory and the repository from it", async () => {
    const { root } = make({ "src/a.ts": "a" });
    expect(findCheckout(join(root, "src"))).toBe(root);
    const cwd = process.cwd();
    process.chdir(join(root, "src"));
    try {
      expect(await resolveRepo()).toBe("alice/app");
    } finally {
      process.chdir(cwd);
    }
  });

  it("sees added, modified and deleted files, and nothing it shouldn't", () => {
    const { root, c } = make({ "a.txt": "a", "src/b.txt": "b", "gone.txt": "g" });
    writeFileSync(join(root, "a.txt"), "a2");
    writeFileSync(join(root, "new.txt"), "n");
    mkdirSync(join(root, ".lizard/workflows"), { recursive: true }); // a repository's CI: content like any other
    writeFileSync(join(root, ".lizard/workflows/ci.yml"), "on: push\n");
    writeFileSync(join(root, ".gitignore"), "*.log\nbuild/\n");
    writeFileSync(join(root, "debug.log"), "x");
    mkdirSync(join(root, "build"));
    writeFileSync(join(root, "build/out.js"), "x");
    mkdirSync(join(root, "node_modules/x"), { recursive: true });
    writeFileSync(join(root, "node_modules/x/i.js"), "x");
    symlinkSync("a.txt", join(root, "link"));
    unlinkSync(join(root, "gone.txt"));
    const ch = changesOf(c, scanWorking(root, c));
    expect(ch).toEqual({ added: [".gitignore", ".lizard/workflows/ci.yml", "link", "new.txt"], modified: ["a.txt"], deleted: ["gone.txt"] });
  });

  it("a sparse checkout only looks inside its folders", () => {
    const { root, c } = make({ "src/a.txt": "a" }, { sparse: ["src"] });
    writeFileSync(join(root, "outside.txt"), "o");
    writeFileSync(join(root, "src/b.txt"), "b");
    expect(changesOf(c, scanWorking(root, c)).added).toEqual(["src/b.txt"]);
  });

  it("diffs lines", () => {
    const d = unifiedDiff("a\nb\nc\n", "a\nB\nc\n", "f");
    expect(d).toContain("@@ -1,4 +1,4 @@");
    expect(d).toContain("-b");
    expect(d).toContain("+B");
  });
});
