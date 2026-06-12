import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Workspace } from "../../src/lib/api.js";

const personalWs: Workspace = {
  id: "ws_personal",
  name: "personal",
  slug: "personal",
  role: "owner",
  isPersonal: true,
  projectCount: 0,
};
const teamWs: Workspace = {
  id: "ws_team",
  name: "acme-team",
  slug: "acme-team",
  role: "member",
  isPersonal: false,
  projectCount: 2,
};

let tmpDir: string;
let originalCwd: string;
let originalIsTTY: boolean | undefined;
let originalLizardHome: string | undefined;

beforeEach(() => {
  originalCwd = process.cwd();
  originalIsTTY = process.stdout.isTTY;
  originalLizardHome = process.env.LIZARD_HOME;

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lizard-init-test-"));
  process.env.LIZARD_HOME = tmpDir;
  process.chdir(tmpDir);
  Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
});

afterEach(() => {
  process.chdir(originalCwd);
  if (originalLizardHome === undefined) delete process.env.LIZARD_HOME;
  else process.env.LIZARD_HOME = originalLizardHome;
  Object.defineProperty(process.stdout, "isTTY", {
    value: originalIsTTY,
    configurable: true,
  });
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.resetModules();
  vi.restoreAllMocks();
});

/**
 * Mock the API for one test. Returns the init module loaded fresh against
 * those mocks so each test gets a clean import.
 */
async function withMockedApi(handlers: {
  get?: (path: string) => unknown;
  post?: (path: string, body?: unknown) => unknown;
}) {
  vi.resetModules();
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  vi.doMock("../../src/lib/api.js", async () => {
    const actual = await vi.importActual<typeof import("../../src/lib/api.js")>(
      "../../src/lib/api.js",
    );
    return {
      ...actual,
      api: {
        get: (p: string) => {
          calls.push({ method: "GET", path: p });
          return Promise.resolve(handlers.get?.(p));
        },
        post: (p: string, body?: unknown) => {
          calls.push({ method: "POST", path: p, body });
          return Promise.resolve(handlers.post?.(p, body));
        },
        put: () => Promise.reject(new Error("unexpected PUT")),
        patch: () => Promise.reject(new Error("unexpected PATCH")),
        delete: () => Promise.reject(new Error("unexpected DELETE")),
      },
    };
  });

  const init = await import("../../src/commands/init.js");
  return { init, calls };
}

describe("ensureLinked — Railway-style workspace flow", () => {
  test("non-TTY, no --name → refuses to auto-create, no POST", async () => {
    const { init, calls } = await withMockedApi({
      get: (p) => (p === "/api/workspaces" ? [personalWs] : []),
      post: () => {
        throw new Error("should not POST in headless without a name");
      },
    });

    await expect(init.ensureLinked({})).rejects.toThrow(
      /no project name was given/i,
    );
    // No project was created.
    expect(calls.find((c) => c.method === "POST")).toBeUndefined();
  });

  test("non-TTY with --name and multiple workspaces: unique hint auto-resolves ws", async () => {
    const projects = [
      { id: "p1", name: "api-backend", slug: "api-backend", workspaceId: "ws_team" },
    ];
    const { init, calls } = await withMockedApi({
      get: (p) => {
        if (p === "/api/workspaces") return [personalWs, teamWs];
        if (p === "/api/projects") return projects;
        if (p.startsWith("/api/projects?workspaceId=ws_team")) return projects;
        return [];
      },
    });

    const link = await init.ensureLinked({ projectName: "api-backend" });

    expect(link.workspaceId).toBe("ws_team");
    expect(link.projectId).toBe("p1");
    // No POST — existing project was matched.
    expect(calls.find((c) => c.method === "POST")).toBeUndefined();
  });

  test("--workspace + --name on a not-yet-existing project → creates in chosen ws", async () => {
    const { init, calls } = await withMockedApi({
      get: (p) => {
        if (p === "/api/workspaces") return [personalWs, teamWs];
        // Project lookup inside the chosen workspace: empty
        return [];
      },
      post: (p, body: any) =>
        p === "/api/projects"
          ? { id: "proj_made", name: body.name, slug: "new-thing" }
          : null,
    });

    const link = await init.ensureLinked({
      workspaceFlag: "acme-team",
      projectName: "new-thing",
    });

    expect(link.workspaceId).toBe("ws_team");
    expect(link.projectId).toBe("proj_made");

    const post = calls.find((c) => c.method === "POST" && c.path === "/api/projects");
    expect((post!.body as any).workspaceId).toBe("ws_team");
    expect((post!.body as any).name).toBe("new-thing");
  });

  test("--name with collisions across workspaces → fails", async () => {
    const projects = [
      { id: "p1", name: "api", slug: "api", workspaceId: "ws_personal" },
      { id: "p2", name: "api", slug: "api", workspaceId: "ws_team" },
    ];
    const { init } = await withMockedApi({
      get: (p) =>
        p === "/api/workspaces"
          ? [personalWs, teamWs]
          : p === "/api/projects"
            ? projects
            : [],
    });

    await expect(init.ensureLinked({ projectName: "api" })).rejects.toThrow(
      /Multiple projects named "api"/,
    );
  });

  test("existing link, no --force → returns existing without API calls", async () => {
    // Key the link under process.cwd() — macOS resolves /var → /private/var,
    // so the symlink path used to seed the file would otherwise not match.
    const cwd = process.cwd();
    fs.mkdirSync(path.join(tmpDir, ".lizard"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, ".lizard", "config.json"),
      JSON.stringify({
        projects: {
          [cwd]: {
            projectId: "proj_existing",
            projectName: "demo",
            workspaceId: "ws_existing",
            workspaceName: "old-ws",
          },
        },
      }),
    );

    const { init, calls } = await withMockedApi({});
    const link = await init.ensureLinked({});

    expect(link.projectId).toBe("proj_existing");
    expect(link.workspaceId).toBe("ws_existing");
    expect(calls).toHaveLength(0);
  });

  test("unknown --workspace flag → clear error", async () => {
    const { init } = await withMockedApi({
      get: (p) => (p === "/api/workspaces" ? [personalWs, teamWs] : []),
    });
    await expect(
      init.ensureLinked({ workspaceFlag: "ghost", projectName: "x" }),
    ).rejects.toThrow(/Workspace "ghost" not found/);
  });
});
