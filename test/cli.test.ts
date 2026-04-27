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

// Prefer the npm-globally-installed lizard (has all deps bundled properly).
// ~/.lizard/bin/lizard is a legacy path that may be an old standalone copy.
const LIZARD = process.env.LIZARD_BIN ?? "lizard";

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
  return execa(LIZARD, ["--json", ...args]).then((r) => extractJSON(r.stdout));
}

function cliFrom(cwd: string, ...args: string[]) {
  return execa(LIZARD, args, { cwd });
}

function cliJSONFrom(cwd: string, ...args: string[]) {
  return execa(LIZARD, ["--json", ...args], { cwd }).then((r) => extractJSON(r.stdout));
}

// Output may mix spinner/prompt text with JSON — the JSON block is always last.
// Try parsing from each `{` or `[` working backwards until one succeeds.
function extractJSON(stdout: string): any {
  const positions: number[] = [];
  for (let i = 0; i < stdout.length; i++) {
    if (stdout[i] === "{" || stdout[i] === "[") positions.push(i);
  }
  for (let i = positions.length - 1; i >= 0; i--) {
    try { return JSON.parse(stdout.slice(positions[i])); } catch {}
  }
  throw new Error(`No JSON found in output:\n${stdout}`);
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

// Temp dir for deploy — must be OUTSIDE the git repo so no remote is detected
let DEPLOY_DIR: string;

describe("deploy", () => {
  const appName = `cli-test-${Date.now()}`;
  let appId: string;

  beforeAll(async () => {
    // Clean up any leftover apps in the project so the CLI creates a fresh one
    // instead of reusing an existing upload-based app (which would fail on redeploy).
    const services = await cliJSON("--project", projectId, "ps").catch(() => ({ apps: [] }));
    const existing: Array<{ id: string }> = services?.apps ?? [];
    for (const app of existing) {
      await cli("--project", projectId, "destroy", app.id, "-y").catch(() => {});
    }
  }, 30_000);

  test(
    "deploy local fixture app (detached)",
    async () => {
      // Copy fixture to a temp dir outside the git repo (no git remote = tarball upload)
      DEPLOY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lizard-test-"));
      for (const entry of fs.readdirSync(FIXTURE, { withFileTypes: true })) {
        if (!entry.isFile()) continue; // skip .lizard dir and symlinks
        fs.copyFileSync(path.join(FIXTURE, entry.name), path.join(DEPLOY_DIR, entry.name));
      }

      // Pre-link DEPLOY_DIR to existing project so ensureLinked() doesn't create a new one
      const cfgPreDeploy = loadConfig();
      cfgPreDeploy.projects ??= {};
      cfgPreDeploy.projects[DEPLOY_DIR] = { projectId };
      saveConfig(cfgPreDeploy);

      // Pipe app name to stdin to answer the interactive name prompt
      const result = await execa(
        LIZARD,
        ["--json", "deploy", "--detach"],
        { cwd: DEPLOY_DIR, input: appName + "\n" },
      );
      const data = extractJSON(result.stdout);
      expect(data).toHaveProperty("appId");
      appId = data.appId;
      createdApps.push(appId);

      // Mirror link to fixture dir so service-secret tests (run from FIXTURE) find it
      const cfgAfter = loadConfig();
      cfgAfter.projects ??= {};
      cfgAfter.projects[FIXTURE] = { projectId, appId };
      saveConfig(cfgAfter);
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

  test("app URL responds with 200", async () => {
    const data = await cliJSON("deploy", "status", appId);
    if (!data.domain) { console.log("  ⚠ no domain yet, skipping URL check"); return; }
    // Retry up to 90s — Caddy + TLS can take a moment after status=running
    let ok = false;
    let lastStatus = 0;
    for (let i = 0; i < 18; i++) {
      try {
        const res = await fetch(`https://${data.domain}`, { signal: AbortSignal.timeout(8_000) });
        lastStatus = res.status;
        if (res.ok) { ok = true; break; }
      } catch {}
      await sleep(5000);
    }
    if (!ok) console.log(`  ⚠ URL not ready after 90s (last status: ${lastStatus}) — proxy may still be warming up`);
    expect(ok).toBe(true);
  }, 120_000);

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

// ── Environments ──────────────────────────────────────────────────────────────

describe("environments", () => {
  let envId: string;
  const ENV_NAME = `cli-test-env-${Date.now()}`;

  test("env list returns an array", async () => {
    const data = await cliJSON("--project", projectId, "env", "list");
    expect(Array.isArray(data)).toBe(true);
  });

  test("env create creates a new environment", async () => {
    const data = await cliJSON("--project", projectId, "env", "create", ENV_NAME);
    expect(data.name).toBe(ENV_NAME);
    expect(data.id).toBeTruthy();
    envId = data.id;
  });

  test("env list includes the created environment", async () => {
    const data = await cliJSON("--project", projectId, "env", "list");
    expect(data.some((e: any) => e.id === envId)).toBe(true);
  });

  test("env vars set applies vars to environment", async () => {
    const data = await cliJSON("env", "vars", "set", envId, "CLI_TEST_KEY=hello");
    expect(data.ok).toBe(true);
    expect(data.staged).toBe(false);
  });

  test("env vars set --stage stages vars without applying", async () => {
    const data = await cliJSON("env", "vars", "set", envId, "CLI_STAGED_KEY=staged", "--stage");
    expect(data.ok).toBe(true);
    expect(data.staged).toBe(true);
  });

  test("env vars list shows applied and staged vars", async () => {
    const data = await cliJSON("env", "vars", "list", envId);
    expect(data.envVars["CLI_TEST_KEY"]).toBe("hello");
    expect(data.stagedEnvVars?.["CLI_STAGED_KEY"]).toBe("staged");
  });

  test("env delete removes the environment", async () => {
    const data = await cliJSON("--project", projectId, "env", "delete", envId);
    expect(data.ok).toBe(true);
  });

  test("env list no longer contains deleted environment", async () => {
    const data = await cliJSON("--project", projectId, "env", "list");
    expect(data.some((e: any) => e.id === envId)).toBe(false);
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
    await execa(LIZARD, ["--project", projectId, "destroy", id, "-y"]).catch(() => {});
  }
  // Clean up temp deploy dir and fixture link
  if (DEPLOY_DIR) fs.rmSync(DEPLOY_DIR, { recursive: true, force: true });
  const cfg = loadConfig();
  if (cfg.projects?.[FIXTURE]) {
    delete cfg.projects[FIXTURE];
    saveConfig(cfg);
  }
});
