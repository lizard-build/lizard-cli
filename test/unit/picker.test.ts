import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import type { Workspace } from "../../src/lib/api.js";

const personalWs: Workspace = {
  id: "ws_personal",
  name: "personal",
  slug: "personal",
  role: "owner",
  isPersonal: true,
  projectCount: 1,
};

const teamWs: Workspace = {
  id: "ws_team",
  name: "acme-team",
  slug: "acme-team",
  role: "member",
  isPersonal: false,
  projectCount: 3,
};

let originalIsTTY: boolean | undefined;

beforeEach(() => {
  originalIsTTY = process.stdout.isTTY;
  // Default to non-TTY so prompts don't hang the test runner.
  Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
});

afterEach(() => {
  Object.defineProperty(process.stdout, "isTTY", {
    value: originalIsTTY,
    configurable: true,
  });
  vi.resetModules();
  vi.restoreAllMocks();
});

async function freshPicker(mockApi: { get: (path: string) => unknown }) {
  vi.resetModules();
  vi.doMock("../../src/lib/api.js", async () => {
    const actual = await vi.importActual<typeof import("../../src/lib/api.js")>(
      "../../src/lib/api.js",
    );
    return { ...actual, api: mockApi };
  });
  return await import("../../src/lib/picker.js");
}

describe("matchWorkspace", () => {
  test("matches by id, slug, and name (case-insensitive)", async () => {
    const picker = await freshPicker({ get: () => [] });
    const list = [personalWs, teamWs];
    expect(picker.matchWorkspace(list, "ws_team")?.id).toBe("ws_team");
    expect(picker.matchWorkspace(list, "acme-team")?.id).toBe("ws_team");
    expect(picker.matchWorkspace(list, "ACME-TEAM")?.id).toBe("ws_team");
    expect(picker.matchWorkspace(list, "Personal")?.id).toBe("ws_personal");
    expect(picker.matchWorkspace(list, "nope")).toBeUndefined();
  });
});

describe("resolveWorkspace", () => {
  test("returns the workspace when the flag matches", async () => {
    const picker = await freshPicker({
      get: () => [personalWs, teamWs],
    });
    const result = await picker.resolveWorkspace("acme-team");
    expect(result.id).toBe("ws_team");
  });

  test("throws with the available list when nothing matches", async () => {
    const picker = await freshPicker({
      get: () => [personalWs, teamWs],
    });
    await expect(picker.resolveWorkspace("ghost")).rejects.toThrow(
      /not found.*personal.*acme-team/,
    );
  });
});

describe("pickWorkspace", () => {
  test("uses --workspace flag when provided", async () => {
    const picker = await freshPicker({
      get: () => [personalWs, teamWs],
    });
    const ws = await picker.pickWorkspace({
      flag: "acme-team",
      workspaces: [personalWs, teamWs],
    });
    expect(ws.id).toBe("ws_team");
  });

  test("auto-selects the only workspace", async () => {
    const picker = await freshPicker({
      get: () => [personalWs],
    });
    const ws = await picker.pickWorkspace({ workspaces: [personalWs] });
    expect(ws.id).toBe("ws_personal");
  });

  test("non-TTY with multiple workspaces falls back to personal", async () => {
    const picker = await freshPicker({
      get: () => [personalWs, teamWs],
    });
    const ws = await picker.pickWorkspace({
      workspaces: [personalWs, teamWs],
    });
    expect(ws.id).toBe("ws_personal");
  });

  test("non-TTY with multiple non-personal workspaces falls back to first", async () => {
    const other: Workspace = { ...teamWs, id: "ws_other", name: "other-team", slug: "other-team" };
    const picker = await freshPicker({
      get: () => [teamWs, other],
    });
    const ws = await picker.pickWorkspace({
      workspaces: [teamWs, other],
    });
    expect(ws.id).toBe("ws_team");
  });

  test("projectNameHint with unique match auto-resolves the workspace", async () => {
    // pickWorkspace will call api.get('/api/projects') to find which ws has the
    // project with name "api-backend" — return one match only.
    const projects = [
      { id: "p1", name: "api-backend", slug: "api-backend", workspaceId: "ws_team" },
      { id: "p2", name: "other", slug: "other", workspaceId: "ws_personal" },
    ];
    const picker = await freshPicker({
      get: (p: string) => (p === "/api/projects" ? projects : []),
    });
    const ws = await picker.pickWorkspace({
      projectNameHint: "api-backend",
      workspaces: [personalWs, teamWs],
    });
    expect(ws.id).toBe("ws_team");
  });

  test("projectNameHint with collisions fails with helpful message", async () => {
    const projects = [
      { id: "p1", name: "api", slug: "api", workspaceId: "ws_personal" },
      { id: "p2", name: "api", slug: "api", workspaceId: "ws_team" },
    ];
    const picker = await freshPicker({
      get: (p: string) => (p === "/api/projects" ? projects : []),
    });
    await expect(
      picker.pickWorkspace({
        projectNameHint: "api",
        workspaces: [personalWs, teamWs],
      }),
    ).rejects.toThrow(/Multiple projects named "api"/);
  });

  test("no workspaces throws a clear error", async () => {
    const picker = await freshPicker({ get: () => [] });
    await expect(
      picker.pickWorkspace({ workspaces: [] }),
    ).rejects.toThrow(/No workspaces available/);
  });
});
