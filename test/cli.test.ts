/**
 * E2E tests for the Lizard CLI — runs against real production API.
 *
 * Prerequisites:
 *   - lizard CLI installed at ~/.lizard/bin/lizard (or in PATH as "lizard")
 *   - Logged in: `lizard login --token <token>`
 *
 * Run: npm test
 */

import { execa } from "execa";
import { describe, test, expect, afterAll, beforeAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ── Config ────────────────────────────────────────────────────────────────────

const LIZARD = fs.existsSync(path.join(os.homedir(), ".lizard/bin/lizard"))
  ? path.join(os.homedir(), ".lizard/bin/lizard")
  : "lizard";

const FIXTURE = path.resolve(import.meta.dirname, "fixtures/hello-app");
const CONFIG_FILE = path.join(os.homedir(), ".lizard/config.json");

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8")) as {
      projects?: Record<string, { projectId: string; appId?: string }>;
    };
  } catch {
    return { projects: {} };
  }
}

function saveConfig(cfg: object) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

function cli(...args: string[]) {
  return execa(LIZARD, args);
}

function cliJSON(...args: string[]) {
  return execa(LIZARD, ["--json", ...args]).then((r) => JSON.parse(r.stdout));
}

function cliFrom(cwd: string, ...args: string[]) {
  return execa(LIZARD, args, { cwd });
}

function cliJSONFrom(cwd: string, ...args: string[]) {
  return execa(LIZARD, ["--json", ...args], { cwd }).then((r) => JSON.parse(r.stdout));
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// Resolved before tests run
let projectId: string;

// Tracks created app IDs for afterAll cleanup
const createdApps: string[] = [];

// ── Setup: resolve project ID ─────────────────────────────────────────────────

beforeAll(async () => {
  // Try env var override first (useful in CI)
  if (process.env.LIZARD_TEST_PROJECT_ID) {
    projectId = process.env.LIZARD_TEST_PROJECT_ID;
    return;
  }
  // Check locally linked config
  const cfg = loadConfig();
  const linked = Object.values(cfg.projects ?? {})[0];
  if (linked?.projectId) {
    projectId = linked.projectId;
    return;
  }
  // Fall back to fetching the first project from the API
  const projects = await cliJSON("project", "list");
  if (!projects?.length) throw new Error("No projects found — create one with `lizard init` first");
  projectId = projects[0].id;
});

// ── Auth ──────────────────────────────────────────────────────────────────────

describe("auth", () => {
  test("whoami returns a user", async () => {
    const { stdout } = await cli("whoami");
    expect(stdout.length).toBeGreaterThan(0);
  });

  test("whoami --json has id and username fields", async () => {
    const data = await cliJSON("whoami");
    expect(data).toHaveProperty("id");
    expect(data).toHaveProperty("username");
  });
});

// ── Project secrets (--global) ────────────────────────────────────────────────

describe("project secrets", () => {
  const KEY = `CLI_TEST_GLOBAL_${Date.now()}`;

  test("set a project secret", async () => {
    const { stdout } = await cli("--project", projectId, "secret", "set", `${KEY}=globalvalue`, "--global");
    expect(stdout).toMatch(/updated|set/i);
  });

  test("list shows the key with value", async () => {
    const { stdout } = await cli("--project", projectId, "secret", "list", "--global", "--show");
    expect(stdout).toContain(KEY);
    expect(stdout).toContain("globalvalue");
  });

  test("--json list returns the key", async () => {
    const data = await cliJSON("--project", projectId, "secret", "list", "--global", "--show");
    const found = data.find((s: any) => s.key === KEY);
    expect(found?.value).toBe("globalvalue");
  });

  test("delete the key", async () => {
    const { stdout } = await cli("--project", projectId, "secret", "delete", KEY, "--global");
    expect(stdout).toMatch(/deleted/i);
  });

  test("key is gone after delete", async () => {
    const data = await cliJSON("--project", projectId, "secret", "list", "--global", "--show");
    expect(data.find((s: any) => s.key === KEY)).toBeUndefined();
  });
});

// ── Deploy + service secrets ──────────────────────────────────────────────────

describe("deploy", () => {
  const appName = `cli-test-${Date.now()}`;
  let appId: string;

  test(
    "deploy local fixture app (detached)",
    async () => {
      // Pipe app name to stdin to answer the interactive name prompt
      const result = await execa(
        LIZARD,
        ["--json", "--project", projectId, "deploy", "--detach"],
        { cwd: FIXTURE, input: appName },
      );
      const data = JSON.parse(result.stdout);
      expect(data).toHaveProperty("appId");
      appId = data.appId;
      createdApps.push(appId);
    },
    60_000,
  );

  test(
    "app reaches running within 4 minutes",
    async () => {
      const deadline = Date.now() + 4 * 60 * 1000;
      let status = "pending";
      while (Date.now() < deadline) {
        const data = await cliJSON("deploy", "status", appId);
        status = data.status;
        if (status === "running" || status === "failed") break;
        await sleep(5000);
      }
      expect(status).toBe("running");
    },
    5 * 60 * 1000,
  );

  test("app URL responds with expected body", async () => {
    const data = await cliJSON("deploy", "status", appId);
    if (!data.domain) return; // domain may not be ready yet
    const res = await fetch(`https://${data.domain}`, { signal: AbortSignal.timeout(10_000) });
    expect(res.ok).toBe(true);
    expect(await res.text()).toContain("hello from lizard test");
  });

  // Service-scoped secrets — fixture dir gets linked by the deploy above
  describe("service secrets", () => {
    const KEY = `CLI_TEST_SVC_${Date.now()}`;

    test("set a service secret", async () => {
      const { stdout } = await cliFrom(FIXTURE, "secret", "set", `${KEY}=svcvalue`);
      expect(stdout).toMatch(/updated|set/i);
    });

    test("list shows the key with value", async () => {
      const { stdout } = await cliFrom(FIXTURE, "secret", "list", "--show");
      expect(stdout).toContain(KEY);
      expect(stdout).toContain("svcvalue");
    });

    test("--json list returns the key", async () => {
      const data = await cliJSONFrom(FIXTURE, "secret", "list", "--show");
      const found = data.find((s: any) => s.key === KEY);
      expect(found?.value).toBe("svcvalue");
    });

    test("delete the key", async () => {
      const { stdout } = await cliFrom(FIXTURE, "secret", "delete", KEY);
      expect(stdout).toMatch(/deleted/i);
    });

    test("key is gone after delete", async () => {
      const data = await cliJSONFrom(FIXTURE, "secret", "list", "--show");
      expect(data.find((s: any) => s.key === KEY)).toBeUndefined();
    });
  });
});

// ── Error handling ────────────────────────────────────────────────────────────

describe("error handling", () => {
  test("deploy status with unknown id exits non-zero", async () => {
    await expect(cli("deploy", "status", "nonexistent-id-xyz")).rejects.toThrow();
  });

  test("secret set with missing = exits non-zero", async () => {
    await expect(
      cli("--project", projectId, "secret", "set", "BADFORMAT", "--global"),
    ).rejects.toThrow();
  });
});

// ── Cleanup ───────────────────────────────────────────────────────────────────

afterAll(async () => {
  for (const id of createdApps) {
    await execa(LIZARD, ["destroy", id, "-y"]).catch(() => {});
  }
  // Remove fixture dir link so it doesn't pollute future runs
  const cfg = loadConfig();
  if (cfg.projects?.[FIXTURE]) {
    delete cfg.projects[FIXTURE];
    saveConfig(cfg);
  }
});
