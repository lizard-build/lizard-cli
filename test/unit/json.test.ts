/**
 * --json flag tests. Runs the built CLI (dist/index.js) and asserts the
 * output is parseable JSON for every command path that promises it.
 *
 * No network, no auth — every test runs with LIZARD_HOME pointed at a fresh
 * tmp dir so credentials and link state are empty. Commands that *would*
 * hit the network are tested only via their pre-network failure paths
 * (auth errors, validation errors) which still surface JSON to stdout.
 *
 * Prereq: `npm run build` (these tests run dist/index.js, not src).
 */

import { execa } from "execa";
import { describe, test, expect, beforeAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const CLI = path.resolve(import.meta.dirname, "../../dist/index.js");
const NODE = process.execPath;

let TMP_HOME: string;
let TMP_CWD: string;

beforeAll(() => {
  if (!fs.existsSync(CLI)) {
    throw new Error(
      `dist/index.js missing — run \`npm run build\` before this suite.`,
    );
  }
  // realpathSync because /var/folders -> /private/var/folders on macOS; the
  // child process resolves the link too and we want cwd assertions to match.
  TMP_HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lizard-json-home-")));
  TMP_CWD = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lizard-json-cwd-")));
});

function run(args: string[], extra: { cwd?: string; env?: Record<string, string> } = {}) {
  return execa(NODE, [CLI, ...args], {
    reject: false,
    cwd: extra.cwd ?? TMP_CWD,
    env: {
      ...process.env,
      LIZARD_HOME: TMP_HOME,
      // Belt-and-suspenders: even if a leaked LIZARD_TOKEN sits in the
      // parent env, drop it so unauth tests can't pass by accident.
      LIZARD_TOKEN: "",
      ...(extra.env ?? {}),
    },
  });
}

function parseJSON(s: string): any {
  return JSON.parse(s);
}

// Top-level commands that should appear in the help dump. Used both to
// assert the dump is complete and to drill into each subcommand's --help
// --json output.
const TOP_LEVEL_COMMANDS = [
  "add", "config", "docs", "domain", "git", "init", "link", "login",
  "logout", "logs", "open", "port", "project", "ps", "redeploy", "regions",
  "restart", "run", "scale", "secrets", "service", "skills", "ssh", "status",
  "unlink", "up", "upgrade", "whoami", "workspace",
];

// ── help dump ────────────────────────────────────────────────────────────────

describe("--help --json dump", () => {
  test("root help dumps the full command tree", async () => {
    const { stdout, exitCode } = await run(["--help", "--json"]);
    expect(exitCode).toBe(0);
    const out = parseJSON(stdout);
    expect(out).toMatchObject({ cli: "lizard" });
    expect(typeof out.version).toBe("string");
    expect(Array.isArray(out.command.subcommands)).toBe(true);
    const names = out.command.subcommands.map((c: any) => c.name);
    for (const cmd of TOP_LEVEL_COMMANDS) {
      expect(names).toContain(cmd);
    }
    // Global --json option must appear at the root.
    expect(out.command.options.some((o: any) => o.long === "--json")).toBe(true);
  });

  test.each(TOP_LEVEL_COMMANDS)(
    "`%s --help --json` is valid JSON and names the command",
    async (cmd) => {
      const { stdout, exitCode } = await run([cmd, "--help", "--json"]);
      expect(exitCode).toBe(0);
      const out = parseJSON(stdout);
      expect(out.command.name).toBe(cmd);
      // globalOptions are exposed once we're inside a subcommand so the
      // dump knows --json/--region/etc. are inherited.
      expect(Array.isArray(out.globalOptions)).toBe(true);
    },
  );

  test("nested subcommand drills correctly (`secrets set --help --json`)", async () => {
    const { stdout, exitCode } = await run(["secrets", "set", "--help", "--json"]);
    expect(exitCode).toBe(0);
    const out = parseJSON(stdout);
    expect(out.command.name).toBe("set");
    expect(out.command.arguments.some((a: any) => a.name === "pairs")).toBe(true);
  });

  test("exitCodes is included in the dump", async () => {
    const { stdout } = await run(["--help", "--json"]);
    const out = parseJSON(stdout);
    expect(out.exitCodes).toMatchObject({
      "0": expect.any(String),
      "2": expect.any(String),
    });
  });
});

// ── status (no auth, no network) ─────────────────────────────────────────────

describe("status --json", () => {
  test("explicit --json from an unlinked cwd returns {linked:false}", async () => {
    const { stdout, exitCode } = await run(["status", "--json"]);
    expect(exitCode).toBe(0);
    const out = parseJSON(stdout);
    expect(out).toMatchObject({ linked: false });
    expect(out.cwd).toBe(TMP_CWD);
  });

  test("non-TTY auto-JSON: piped `status` (no flag) also returns JSON", async () => {
    // execa pipes stdout → process.stdout.isTTY === false in the child →
    // preAction enables JSON mode automatically.
    const { stdout, exitCode } = await run(["status"]);
    expect(exitCode).toBe(0);
    const out = parseJSON(stdout);
    expect(out).toHaveProperty("linked");
    expect(out).toHaveProperty("cwd");
  });
});

// ── upgrade (no auth) ────────────────────────────────────────────────────────

describe("upgrade --json", () => {
  // Network reachability isn't guaranteed in every CI; we just assert that
  // *some* JSON object comes out for both `--check` and the bare form,
  // regardless of which branch fires (rate-limited / error / up-to-date /
  // update-available). All four branches now emit JSON.
  test("--check --json always emits a JSON payload", async () => {
    const { stdout, exitCode } = await run(["upgrade", "--check", "--json"]);
    expect(exitCode).toBe(0);
    const out = parseJSON(stdout);
    expect(out).toHaveProperty("currentVersion");
  }, 20_000);
});

// ── error path: auth ────────────────────────────────────────────────────────

describe("error JSON to stdout", () => {
  test("whoami with no credentials emits JSON error + exit 2", async () => {
    // LIZARD_HOME points at an empty tmp dir → no creds → non-TTY (execa
    // pipes) so requireAuth throws NOT_AUTHENTICATED instead of prompting.
    const { stdout, exitCode } = await run(["whoami", "--json"]);
    expect(exitCode).toBe(2);
    const out = parseJSON(stdout);
    expect(out.error).toBeDefined();
    expect(out.error.code).toBe("NOT_AUTHENTICATED");
    expect(typeof out.error.message).toBe("string");
  });

  test("auto-JSON: non-TTY whoami without --json still emits JSON error", async () => {
    const { stdout, exitCode } = await run(["whoami"]);
    expect(exitCode).toBe(2);
    const out = parseJSON(stdout);
    expect(out.error.code).toBe("NOT_AUTHENTICATED");
  });

  test("unknown command with --json doesn't write JSON-corrupting text to stdout", async () => {
    // Commander rejects unknown commands before preAction. Our early
    // setJSONMode(true) in main() lets the catch block still know --json
    // was requested. The error message itself goes through commander's
    // own path (stderr) — we just need stdout to stay parseable-or-empty.
    const { stdout, exitCode } = await run(["totally-nonexistent-cmd", "--json"]);
    expect(exitCode).not.toBe(0);
    // stdout may legitimately be empty (commander prints to stderr) or
    // contain a JSON error object — never plain text.
    const trimmed = stdout.trim();
    if (trimmed) {
      expect(() => parseJSON(trimmed)).not.toThrow();
    }
  });
});

// ── stdout cleanliness ───────────────────────────────────────────────────────

describe("stdout cleanliness in JSON mode", () => {
  test("status --json stdout parses end-to-end (no spinner/info leak)", async () => {
    const { stdout } = await run(["status", "--json"]);
    // The whole stdout must be exactly one JSON value with optional
    // trailing newline — no ANSI escapes, no leading spinner frames.
    expect(stdout.trim().endsWith("}")).toBe(true);
    expect(() => parseJSON(stdout)).not.toThrow();
    // No ANSI escape sequences from chalk should leak into stdout.
    // eslint-disable-next-line no-control-regex
    expect(stdout).not.toMatch(/\x1b\[/);
  });

  test("help dump JSON contains no ANSI escapes either", async () => {
    const { stdout } = await run(["--help", "--json"]);
    // eslint-disable-next-line no-control-regex
    expect(stdout).not.toMatch(/\x1b\[/);
  });
});
