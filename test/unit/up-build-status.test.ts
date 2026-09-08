import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ get: vi.fn(), stream: vi.fn() }));
vi.mock("../../src/lib/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/api.js")>();
  return { ...actual, api: { ...actual.api, get: mocks.get }, streamSSE: mocks.stream };
});
import { streamBuildLogs } from "../../src/commands/up.js";
import { setJSONMode } from "../../src/lib/format.js";

describe("upload build result", () => {
  let output: string;
  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = 0;
    setJSONMode(true);
    output = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: any) => { output += chunk; return true; });
  });
  afterEach(() => { process.exitCode = 0; setJSONMode(false); vi.restoreAllMocks(); });

  it.each([false, true])("returns failure after an SSE build error (CI=%s)", async (ci) => {
    mocks.stream.mockImplementation(async (_url, receive) => { receive("error", '"failed"'); });
    mocks.get.mockResolvedValue({ status: "failed" });
    await streamBuildLogs("app", ci, "build");
    expect(process.exitCode).toBe(1);
    expect(output).not.toContain('"event":"deployed"');
    expect(mocks.get).not.toHaveBeenCalledWith("/api/apps/app");
  });

  it("uses the failed build state even when an older app is still running", async () => {
    mocks.stream.mockResolvedValue(undefined);
    mocks.get.mockImplementation(async (url) => url === "/api/builds/build" ? { status: "failed" } : { status: "running" });
    await streamBuildLogs("app", false, "build");
    expect(process.exitCode).toBe(1);
    expect(output).not.toContain("deployed");
  });

  it("keeps a successful build and running app successful", async () => {
    mocks.stream.mockImplementation(async (_url, receive) => { receive("done", ""); });
    mocks.get.mockImplementation(async (url) => url === "/api/builds/build" ? { status: "done" } : { status: "running", domain: "example.test" });
    await streamBuildLogs("app", false, "build");
    expect(process.exitCode).toBe(0);
    expect(output).toContain('"event":"deployed"');
  });
});
