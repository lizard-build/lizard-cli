import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isSensitivePath, parseIgnore } from "../../src/lib/upload-filter.js";
import { getUploadFiles } from "../../src/commands/up.js";

describe("files that look like secrets", () => {
  it.each([".env", ".env.local", ".env.production", "app/.env", ".ssh/id_rsa", "x/.aws/credentials", ".gnupg/pubring.kbx", ".npmrc",
    ".pypirc", ".netrc", ".docker/config.json", "id_rsa", "id_rsa.pub", "keys/id_ed25519", "id_ecdsa", "server.pem", "tls/server.KEY", ".ssh"])(
    "%s is skipped", (p) => expect(isSensitivePath(p)).toBe(true));
  it.each([".env.example", ".env.sample", "src/env.ts", "config.json", "docker/config.json", "keyboard.ts", "README.md", "environment.yml"])(
    "%s is uploaded", (p) => expect(isSensitivePath(p)).toBe(false));
});

describe(".lizardignore (gitignore syntax)", () => {
  const m = parseIgnore("# comment\n*.log\n/build\ndata/\n!keep.log\ndocs/**/*.pdf\nsecret?.txt\n");
  it.each([["a.log", true], ["x/y/a.log", true], ["keep.log", false], ["build/out.js", true], ["src/build/x", false],
    ["data/a.csv", true], ["a/data/b", true], ["docs/a/b/c.pdf", true], ["docs/c.pdf", true], ["secret1.txt", true], ["secret12.txt", false],
    ["src/index.ts", false]] as const)("%s -> %s", (p, want) => expect(m(p)).toBe(want));
  it("a folder-only rule does not match a file of that name", () => expect(m("data")).toBe(false));
});

describe("lizard up file selection", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "lizard-up-files-"));
    const w = (p: string, t = "x") => {
      fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
      fs.writeFileSync(path.join(dir, p), t);
    };
    w("index.js"); w(".env"); w(".env.example"); w(".ssh/id_rsa"); w("certs/tls.pem"); w("tmp/big.bin"); w("notes.txt");
    w(".lizardignore", "tmp/\nnotes.txt\n");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("folder walk: secrets skipped and reported, .lizardignore honoured", () => {
    const r = getUploadFiles(dir, false);
    expect(r.files.sort()).toEqual([".env.example", ".lizardignore", "index.js"]);
    expect(r.skipped.sort()).toEqual([".env", ".ssh/", "certs/tls.pem"]);
  });

  it("refuses the home folder", () => {
    vi.stubEnv("HOME", dir);
    expect(() => getUploadFiles(dir, false)).toThrow(/home folder/);
  });

  it("git listing: .lizardignore honoured, untracked .env warned about", () => {
    const git = (c: string) => execSync(`git ${c}`, { cwd: dir, stdio: "pipe", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
    git("init -q");
    git("add index.js");
    const r = getUploadFiles(dir, true);
    expect(r.files).not.toContain("notes.txt");
    expect(r.files).not.toContain("tmp/big.bin");
    expect(r.files).toContain(".env");
    expect(r.untrackedEnv).toEqual([".env"]);
  });
});
