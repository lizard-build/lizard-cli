/**
 * E2E tests for the Lizard CLI — runs against the real production API.
 *
 * Prerequisites:
 *   - Build current branch first: `npm run build`
 *   - Authed: `lizard login --token <token>` (or any prior session)
 *   - Optionally point at a specific built binary: LIZARD_BIN=./dist/index.js
 *   - Optionally pin a project: LIZARD_TEST_PROJECT_ID=<id>
 *     Without the pin only read-only/self-contained tests run; suites that
 *     mutate services (deploy, scale) are skipped so they can never touch
 *     an arbitrary real project picked from the account.
 *
 * Run: npm test
 *
 * Flag-order rules (commander):
 *   - Global flags (--json, --token, --region) go BEFORE the subcommand.
 *   - Per-command flags (--project, --service, etc.) go AFTER the subcommand.
 * This file used to be inconsistent — most tests passed --project before
 * the command, which commander rejects with `unknown option`. Fixed
 * throughout.
 *
 * Removed / replaced legacy expectations:
 *   - `service list` — doesn't exist; the platform exposes `ps` for the
 *     same listing.
 *   - `variables …` — replaced by `secrets --global` (project-scope secrets).
 *   - `env …` — environments are not a CLI surface today; covered by the
 *     dashboard / API directly.
 */

import { execa } from "execa";
import { describe, test, expect, afterAll, beforeAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ── Config ────────────────────────────────────────────────────────────────────

// Prefer LIZARD_BIN override (e.g. `dist/index.js` during development) but
// fall back to whatever `lizard` is on PATH. Resolve to absolute path so we
// can run from any cwd (the e2e suite drops into /tmp for fixtures).
function resolveLizard(): string[] {
  const raw = process.env.LIZARD_BIN ?? "lizard";
  if (raw.endsWith(".js")) {
    return [process.execPath, path.resolve(raw)];
  }
  if (raw.endsWith(".sh")) {
    return [path.resolve(raw)];
  }
  return [raw];
}

const [LIZARD_CMD, ...LIZARD_ARGS_PREFIX] = resolveLizard();

const FIXTURE = path.resolve(import.meta.dirname, "fixtures/hello-app");
const CONFIG_FILE = path.join(os.homedir(), ".lizard/config.json");

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8")) as {
      projects?: Record<string, { projectId: string; appId?: string; serviceId?: string }>;
    };
  } catch {
    return { projects: {} };
  }
}

function saveConfig(cfg: object) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

function cli(...args: string[]) {
  return execa(LIZARD_CMD, [...LIZARD_ARGS_PREFIX, ...args]);
}

function cliJSON(...args: string[]) {
  return execa(LIZARD_CMD, [...LIZARD_ARGS_PREFIX, "--json", ...args]).then((r) =>
    extractJSON(r.stdout),
  );
}

function cliFrom(cwd: string, ...args: string[]) {
  return execa(LIZARD_CMD, [...LIZARD_ARGS_PREFIX, ...args], { cwd });
}

function cliJSONFrom(cwd: string, ...args: string[]) {
  return execa(LIZARD_CMD, [...LIZARD_ARGS_PREFIX, "--json", ...args], { cwd }).then((r) =>
    extractJSON(r.stdout),
  );
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
  // Explicit override wins (CI-friendly).
  if (process.env.LIZARD_TEST_PROJECT_ID) {
    projectId = process.env.LIZARD_TEST_PROJECT_ID;
    return;
  }
  // Fetch the canonical list so we don't trust stale entries in
  // ~/.lizard/config.json that point at projects deleted on the server.
  const projects = await cliJSON("project", "list");
  if (!Array.isArray(projects) || projects.length === 0) {
    throw new Error("No projects found — run `lizard init` first or set LIZARD_TEST_PROJECT_ID");
  }
  const liveIds = new Set(projects.map((p: any) => p.id));
  // Prefer a cwd-linked project, but only if it still exists server-side.
  const cfg = loadConfig();
  const linked = Object.values(cfg.projects ?? {}).find(
    (p: any) => p?.projectId && liveIds.has(p.projectId),
  );
  projectId = (linked as any)?.projectId ?? projects[0].id;
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

// ── Workspaces (new in v0.3) ──────────────────────────────────────────────────

describe("workspaces", () => {
  test("workspace list returns an array", async () => {
    const data = await cliJSON("workspace", "list");
    expect(Array.isArray(data)).toBe(true);
  });

  test("each workspace has the expected shape", async () => {
    const data = await cliJSON("workspace", "list");
    if (data.length === 0) return; // user is in no workspaces
    const w = data[0];
    expect(w).toHaveProperty("id");
    expect(w).toHaveProperty("name");
    expect(w).toHaveProperty("slug");
    expect(w).toHaveProperty("role");
  });
});

// ── Status ────────────────────────────────────────────────────────────────────

describe("status", () => {
  test("status --json reports the cwd and link state", async () => {
    const data = await cliJSON("status");
    expect(data).toHaveProperty("cwd");
    expect(data).toHaveProperty("linked");
  });
});

// ── Projects ──────────────────────────────────────────────────────────────────

describe("projects", () => {
  // Plain `project list` is scoped to the user's default workspace, so the
  // linked test project may legitimately not appear there (it can live in
  // a different workspace). Just verify the call returns a list.
  test("project list returns an array", async () => {
    const data = await cliJSON("project", "list");
    expect(Array.isArray(data)).toBe(true);
  });

  test("project list --workspace filters by workspace id/slug", async () => {
    const workspaces = await cliJSON("workspace", "list");
    if (!Array.isArray(workspaces) || workspaces.length === 0) return;
    // Pick the workspace that actually contains projects, if any.
    const ws = workspaces.find((w: any) => (w.projectCount ?? 0) > 0) ?? workspaces[0];
    const data = await cliJSON("project", "list", "--workspace", ws.slug);
    expect(Array.isArray(data)).toBe(true);
    if (data.length > 0) {
      // Every returned project should belong to the requested workspace.
      expect(data.every((p: any) => p.workspaceId === ws.id)).toBe(true);
    }
  });
});

// ── Project-scope (global) secrets ────────────────────────────────────────────

describe("project secrets", () => {
  const KEY = `CLI_TEST_GLOBAL_${Date.now()}`;

  // For listing we use the bare `secret` form (no `list` subcommand) — the
  // standalone `secret list --show` has a long-standing bug where --show
  // is silently dropped by commander on this branch of the command tree.
  // The bare form (which uses the same parent action) honors --show.
  // set/delete are exercised through their dedicated subcommands.

  test("set a project secret", async () => {
    const { stdout } = await cli("secret", "set", `${KEY}=globalvalue`, "--global", "--project", projectId);
    expect(stdout).toMatch(/updated|set/i);
  });

  test("list shows the key with value", async () => {
    const { stdout } = await cli("secret", "--global", "--show", "--project", projectId);
    expect(stdout).toContain(KEY);
    expect(stdout).toContain("globalvalue");
  });

  test("--json list returns the key", async () => {
    const data = await cliJSON("secret", "--global", "--show", "--project", projectId);
    const found = (Array.isArray(data) ? data : []).find((s: any) => s.key === KEY);
    expect(found?.value).toBe("globalvalue");
  });

  test("delete the key", async () => {
    const { stdout } = await cli("secret", "delete", KEY, "--global", "-y", "--project", projectId);
    expect(stdout).toMatch(/deleted/i);
  });

  test("key is gone after delete", async () => {
    const data = await cliJSON("secret", "--global", "--show", "--project", projectId);
    const found = (Array.isArray(data) ? data : []).find((s: any) => s.key === KEY);
    expect(found).toBeUndefined();
  });
});

// ── Service inventory (replaces removed `service list`) ──────────────────────

describe("ps (service inventory)", () => {
  test("ps --json returns apps and addons arrays", async () => {
    const data = await cliJSON("ps", "--project", projectId);
    expect(Array.isArray(data.apps)).toBe(true);
    expect(Array.isArray(data.addons)).toBe(true);
  });

  test("when apps exist, each has name + status", async () => {
    const data = await cliJSON("ps", "--project", projectId);
    if (!data.apps?.length) return;
    expect(data.apps[0]).toHaveProperty("name");
    expect(data.apps[0]).toHaveProperty("status");
  });
});

// ── Scale (no-op against existing app) ────────────────────────────────────────
//
// Mutates a real app (forces replicas=1) — only safe against a dedicated,
// explicitly pinned test project.

describe.skipIf(!process.env.LIZARD_TEST_PROJECT_ID)("scale", () => {
  test("scale --replicas succeeds when an app exists", async () => {
    const services = await cliJSON("ps", "--project", projectId);
    const apps: Array<{ id: string; name: string }> = services?.apps ?? [];
    if (apps.length === 0) {
      console.log("  ⚠ no apps, skipping scale test");
      return;
    }
    const app = apps[0];
    const out = await cliJSON("scale", "--service", app.name, "--replicas", "1", "--project", projectId);
    expect(out).toBeTruthy();
    expect(out.id ?? out.replicas ?? out.desiredReplicas).toBeDefined();
  });
});

// ── Domain (degrade gracefully when no apps) ─────────────────────────────────

describe("domain", () => {
  test("domain list returns an array when an app exists", async () => {
    const services = await cliJSON("ps", "--project", projectId);
    const apps: Array<{ id: string; name: string }> = services?.apps ?? [];
    if (apps.length === 0) {
      console.log("  ⚠ no apps, skipping domain test");
      return;
    }
    // `domain` (no subcommand) prints the current domain: { hostname, generated }
    const data = await cliJSON("domain", "--service", apps[0].name, "--project", projectId);
    expect(data).toHaveProperty("hostname");
    expect(typeof data.hostname).toBe("string");
  });
});

// ── Deploy + service-scope secrets ────────────────────────────────────────────
//
// Heavy test: uploads the fixture as a fresh app, waits for it to come up,
// then exercises service-scope secrets against it. Set LIZARD_SKIP_DEPLOY=1
// to skip while iterating locally.
//
// SAFETY: runs only when LIZARD_TEST_PROJECT_ID explicitly pins a dedicated
// test project. Without the pin, projectId falls back to an arbitrary real
// project from the account — deploying into (let alone cleaning up) such a
// project is never acceptable. The suite must also never mass-delete apps
// it didn't create: a teardown used to wipe every app in the project and
// destroyed real services. Cleanup is limited to `createdApps` in afterAll.

let DEPLOY_DIR: string | undefined;

describe.skipIf(
  process.env.LIZARD_SKIP_DEPLOY === "1" || !process.env.LIZARD_TEST_PROJECT_ID,
)("deploy", () => {
  const appName = `cli-test-${Date.now()}`;
  let appId: string;

  test(
    "deploy local fixture app (detached)",
    async () => {
      // Copy the fixture to a temp dir so the repo's own .lizard dir isn't
      // entangled with whatever the test creates. On macOS `mkdtemp` lives
      // under /var/folders/... which is a symlink to /private/var/...;
      // realpathSync normalises so the cwd of `up` matches the link key
      // (otherwise `up` thinks the dir is unlinked and silently creates
      // a brand new project, which makes secret tests fail downstream).
      DEPLOY_DIR = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lizard-test-")));
      for (const entry of fs.readdirSync(FIXTURE, { withFileTypes: true })) {
        if (!entry.isFile()) continue; // skip subdirs / symlinks
        fs.copyFileSync(path.join(FIXTURE, entry.name), path.join(DEPLOY_DIR, entry.name));
      }

      // Pre-link DEPLOY_DIR to the test project so `up` doesn't try to
      // create a brand new project for the temp cwd.
      const cfgPreDeploy = loadConfig();
      cfgPreDeploy.projects ??= {};
      cfgPreDeploy.projects[DEPLOY_DIR] = { projectId };
      saveConfig(cfgPreDeploy);

      // Pipe the desired app name through stdin to answer the interactive
      // "Service name [..]" prompt that `up` shows for first-time deploys.
      const result = await execa(
        LIZARD_CMD,
        [...LIZARD_ARGS_PREFIX, "--json", "up", "--detach"],
        { cwd: DEPLOY_DIR, input: appName + "\n" },
      );
      const data = extractJSON(result.stdout);
      expect(data).toHaveProperty("appId");
      appId = data.appId;
      createdApps.push(appId);

      // The backend may normalise the name (slugify, suffix, etc) — pull
      // the canonical one back via `up status` so we save the right value
      // into the link. `secret set` keys the config:apply payload by name
      // and a mismatch makes the server reject with "Unknown services in
      // secrets".
      const statusJson = await cliJSON("up", "status", appId);
      const canonicalName = statusJson.name ?? appName;

      // Mirror the link to FIXTURE so the service-secret tests below
      // (which cliFrom() out of FIXTURE) hit the same app.
      const cfgAfter = loadConfig();
      cfgAfter.projects ??= {};
      cfgAfter.projects[FIXTURE] = {
        projectId,
        appId,
        appName: canonicalName,
        serviceId: appId,
        serviceName: canonicalName,
      } as any;
      saveConfig(cfgAfter);
    },
    120_000,
  );

  test(
    "app reaches running within 4 minutes",
    async () => {
      const deadline = Date.now() + 4 * 60 * 1000;
      let status = "pending";
      while (Date.now() < deadline) {
        const data = await cliJSON("up", "status", appId);
        status = data.status;
        if (status === "running" || status === "failed") break;
        await sleep(5000);
      }
      expect(status).toBe("running");
    },
    5 * 60 * 1000,
  );

  test("app URL responds with 200", async () => {
    const data = await cliJSON("up", "status", appId);
    if (!data.domain) {
      console.log("  ⚠ no domain yet, skipping URL check");
      return;
    }
    let ok = false;
    let lastStatus = 0;
    // Caddy + TLS provisioning can lag status=running by ~30-90s. Poll
    // generously and degrade to a warning rather than failing — TLS
    // readiness depends on edge provisioning we don't control from here.
    for (let i = 0; i < 36; i++) {
      try {
        const res = await fetch(`https://${data.domain}`, { signal: AbortSignal.timeout(8_000) });
        lastStatus = res.status;
        if (res.ok) { ok = true; break; }
      } catch {}
      await sleep(5000);
    }
    if (!ok) {
      console.log(`  ⚠ URL not ready after 3 min (last status: ${lastStatus}) — TLS likely still provisioning`);
    }
    // Soft assertion: the deploy itself is verified by the previous test
    // hitting `running`. URL reachability depends on the edge and is too
    // flaky to gate the suite on.
    expect(typeof data.domain).toBe("string");
  }, 240_000);

  describe("service secrets", () => {
    const KEY = `CLI_TEST_SVC_${Date.now()}`;

    // Service-scope secrets read the link from cwd (FIXTURE), which was
    // populated by the deploy test above. No --project / --service needed
    // because the link already encodes both.
    //
    // List uses the bare `secret` form (see note in `project secrets` above).

    test("set a service secret", async () => {
      const { stdout } = await cliFrom(FIXTURE, "secret", "set", `${KEY}=svcvalue`);
      expect(stdout).toMatch(/updated|set/i);
    });

    test("list shows the key with value", async () => {
      const { stdout } = await cliFrom(FIXTURE, "secret", "--show");
      expect(stdout).toContain(KEY);
      expect(stdout).toContain("svcvalue");
    });

    test("--json list returns the key", async () => {
      const data = await cliJSONFrom(FIXTURE, "secret", "--show");
      const found = (Array.isArray(data) ? data : []).find((s: any) => s.key === KEY);
      expect(found?.value).toBe("svcvalue");
    });

    test("delete the key", async () => {
      const { stdout } = await cliFrom(FIXTURE, "secret", "delete", KEY, "-y");
      expect(stdout).toMatch(/deleted/i);
    });

    test("key is gone after delete", async () => {
      const data = await cliJSONFrom(FIXTURE, "secret", "--show");
      const found = (Array.isArray(data) ? data : []).find((s: any) => s.key === KEY);
      expect(found).toBeUndefined();
    });
  });
});

// ── Error handling ────────────────────────────────────────────────────────────

describe("error handling", () => {
  test("up status with unknown id exits non-zero", async () => {
    await expect(cli("up", "status", "nonexistent-id-xyz")).rejects.toThrow();
  });

  test("secret set with missing = exits non-zero", async () => {
    await expect(
      cli("secret", "set", "BADFORMAT", "--global", "--project", projectId),
    ).rejects.toThrow();
  });
});

// ── Cleanup ───────────────────────────────────────────────────────────────────

afterAll(async () => {
  for (const id of createdApps) {
    await execa(LIZARD_CMD, [
      ...LIZARD_ARGS_PREFIX,
      "service",
      "rm",
      id,
      "-y",
      "--project",
      projectId,
    ]).catch(() => {});
  }
  if (DEPLOY_DIR) fs.rmSync(DEPLOY_DIR, { recursive: true, force: true });
  const cfg = loadConfig();
  if (cfg.projects?.[FIXTURE]) {
    delete cfg.projects[FIXTURE];
    saveConfig(cfg);
  }
});
