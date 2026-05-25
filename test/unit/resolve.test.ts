import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let tmpDir: string;
let originalCwd: string;
let originalLizardHome: string | undefined;

beforeEach(() => {
  originalCwd = process.cwd();
  originalLizardHome = process.env.LIZARD_HOME;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lizard-resolve-test-"));
  process.env.LIZARD_HOME = tmpDir;
  process.chdir(tmpDir);
});

afterEach(() => {
  process.chdir(originalCwd);
  if (originalLizardHome === undefined) delete process.env.LIZARD_HOME;
  else process.env.LIZARD_HOME = originalLizardHome;
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.resetModules();
});

async function withMockedApi(getHandler: (path: string) => unknown) {
  vi.resetModules();
  const calls: string[] = [];
  vi.doMock("../../src/lib/api.js", async () => {
    const actual = await vi.importActual<typeof import("../../src/lib/api.js")>(
      "../../src/lib/api.js",
    );
    return {
      ...actual,
      api: {
        get: (p: string) => {
          calls.push(p);
          return Promise.resolve(getHandler(p));
        },
        post: () => Promise.reject(new Error("unexpected POST")),
        put: () => Promise.reject(new Error("unexpected PUT")),
        patch: () => Promise.reject(new Error("unexpected PATCH")),
        delete: () => Promise.reject(new Error("unexpected DELETE")),
      },
    };
  });
  const resolve = await import("../../src/lib/resolve.js");
  const config = await import("../../src/lib/config.js");
  return { resolve, config, calls };
}

function writeLink(homeDir: string, link: Record<string, unknown>) {
  // Key under process.cwd() — macOS symlinks /var → /private/var so the
  // disk-stored path must match what getProjectLink() will lookup.
  const cwdKey = process.cwd();
  fs.mkdirSync(path.join(homeDir, ".lizard"), { recursive: true });
  fs.writeFileSync(
    path.join(homeDir, ".lizard", "config.json"),
    JSON.stringify({ projects: { [cwdKey]: link } }),
  );
}

describe("resolveProjectScope", () => {
  test("uses workspaceId from the link when present", async () => {
    writeLink(tmpDir, {
      projectId: "proj_1",
      workspaceId: "ws_already",
      workspaceName: "team",
      environmentName: "staging",
    });

    const { resolve, calls } = await withMockedApi(() => null);
    const { projectId, scope } = await resolve.resolveProjectScope();

    expect(projectId).toBe("proj_1");
    expect(scope.workspaceId).toBe("ws_already");
    expect(scope.environmentName).toBe("staging");
    // No need to fetch the project — workspaceId was already on disk.
    expect(calls.filter((c) => c.startsWith("/api/projects/proj_1"))).toHaveLength(0);
  });

  test("lazy-fills workspaceId when missing and updates the link on disk", async () => {
    writeLink(tmpDir, { projectId: "proj_legacy", projectName: "old" });

    const { resolve, config, calls } = await withMockedApi((p) =>
      p === "/api/projects/proj_legacy"
        ? { workspaceId: "ws_fetched", workspaceName: "fetched-ws" }
        : null,
    );

    const { scope } = await resolve.resolveProjectScope();
    expect(scope.workspaceId).toBe("ws_fetched");
    expect(calls).toContain("/api/projects/proj_legacy");

    const linkAfter = config.getProjectLink(process.cwd());
    expect(linkAfter?.workspaceId).toBe("ws_fetched");
    expect(linkAfter?.workspaceName).toBe("fetched-ws");
  });

  test("returns null scope when the lookup fails", async () => {
    writeLink(tmpDir, { projectId: "proj_unknown" });
    const { resolve } = await withMockedApi(() => {
      throw new Error("404");
    });

    const { scope } = await resolve.resolveProjectScope();
    expect(scope.workspaceId).toBeFalsy();
  });
});

describe("getScope", () => {
  test("returns normalized scope from a resolved context", async () => {
    vi.resetModules();
    const { getScope } = await import("../../src/lib/resolve.js");
    expect(
      getScope({
        projectId: "x",
        workspaceId: "ws_1",
        environment: { id: "e", name: "production" },
      }),
    ).toEqual({ workspaceId: "ws_1", environmentName: "production" });
    expect(getScope({ projectId: "x" })).toEqual({
      workspaceId: null,
      environmentName: null,
    });
  });
});
