import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveProjectId, getProjectLink, setProjectLink } from "../../src/lib/config.js";
import { resetDefaultProject } from "../../src/lib/default-project.js";
import { ensureLinked } from "../../src/commands/init.js";
import { setBaseURL, setAccessToken } from "../../src/lib/api.js";
import { setJSONMode } from "../../src/lib/format.js";

const fetchMock = vi.fn();
let tmpHome: string;
let tmpCwd: string;
let cwd: string;
const savedHome = process.env.LIZARD_HOME;

const project = { id: "p-default", name: "ada's Project", slug: "ada", workspaceId: "ws-1", workspaceName: "ada" };

function reply(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function routes(table: Record<string, () => Response>) {
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${new URL(url).pathname}`;
    return table[key]?.() ?? reply(404, { error: `no route ${key}` });
  });
}

const requested = () => fetchMock.mock.calls.map(([url, init]) => `${init?.method ?? "GET"} ${new URL(url).pathname}`);

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "lizard-default-home-"));
  tmpCwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lizard-default-cwd-")));
  process.env.LIZARD_HOME = tmpHome;
  cwd = process.cwd();
  process.chdir(tmpCwd);
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  setBaseURL("https://lizard.build");
  setAccessToken("tok");
  setJSONMode(true);
  resetDefaultProject();
});

afterEach(() => {
  process.chdir(cwd);
  if (savedHome === undefined) delete process.env.LIZARD_HOME;
  else process.env.LIZARD_HOME = savedHome;
  vi.unstubAllGlobals();
  setJSONMode(false);
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(tmpCwd, { recursive: true, force: true });
});

describe("resolveProjectId in an unlinked folder", () => {
  test("uses the account's default project, asking the platform once per run", async () => {
    routes({ "GET /api/projects/default": () => reply(200, project) });
    expect(await resolveProjectId()).toBe("p-default");
    expect(await resolveProjectId()).toBe("p-default");
    expect(requested()).toEqual(["GET /api/projects/default"]);
  });

  test("a linked folder or --project never asks for it", async () => {
    setProjectLink({ projectId: "p-linked" });
    expect(await resolveProjectId()).toBe("p-linked");
    expect(await resolveProjectId("abcdefghijklmnopqrstu")).toBe("abcdefghijklmnopqrstu");
    expect(requested()).toEqual([]);
  });

  test("no default project, or a platform without the route: the old error", async () => {
    routes({ "GET /api/projects/default": () => reply(404, { error: "none", code: "NO_DEFAULT_PROJECT" }) });
    await expect(resolveProjectId()).rejects.toThrow("No project linked. Run `lizard init` or pass --project <id>.");
  });

  test("a sign-in problem is not mistaken for a missing project", async () => {
    routes({ "GET /api/projects/default": () => reply(401, { error: "Unauthorized" }) });
    await expect(resolveProjectId()).rejects.toMatchObject({ status: 401 });
  });
});

describe("lizard up in an unlinked folder", () => {
  test("links the folder to the default project without asking", async () => {
    routes({ "GET /api/projects/default": () => reply(200, project) });
    const link = await ensureLinked({ useDefault: true });

    expect(link).toEqual({ projectId: "p-default", projectName: "ada's Project", workspaceId: "ws-1", workspaceName: "ada" });
    expect(getProjectLink()).toMatchObject({ projectId: "p-default" });
    expect(requested()).toEqual(["GET /api/projects/default"]);
  });

  test("--project, or lizard init itself, still goes through the old flow", async () => {
    routes({});
    await expect(ensureLinked({ useDefault: true, projectName: "api" })).rejects.toThrow();
    await expect(ensureLinked({})).rejects.toThrow();
    expect(requested()).not.toContain("GET /api/projects/default");
  });

  test("an already linked folder stays as it is", async () => {
    setProjectLink({ projectId: "p-linked" });
    expect((await ensureLinked({ useDefault: true })).projectId).toBe("p-linked");
    expect(requested()).toEqual([]);
  });
});
