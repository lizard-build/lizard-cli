import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/auth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/auth.js")>();
  return { ...actual, getToken: () => "token" };
});
import { deployFromLocal } from "../../src/commands/up.js";
import { setJSONMode } from "../../src/lib/format.js";

describe("up region", () => {
  let dir: string;
  let urls: URL[];
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "lz-up-"));
    fs.writeFileSync(path.join(dir, "index.js"), "console.log(1)\n");
    process.env.LIZARD_HOME = dir;
    urls = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      urls.push(new URL(url));
      return new Response(JSON.stringify({ id: "a1", name: "svc" }), { status: 201 });
    }));
    setJSONMode(true);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    setJSONMode(false);
    delete process.env.LIZARD_HOME;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const deploy = (extra: { region?: string; existingServiceId?: string }) =>
    deployFromLocal({
      projectId: "p1", scope: {}, targetPath: dir, useGitignore: false, serviceFlag: "svc",
      existingServiceId: undefined, region: undefined, opts: { detach: true }, ...extra,
    });

  it("creates a new service in us-east-1 when no --region is given", async () => {
    await deploy({});
    expect(urls[0].pathname).toBe("/api/projects/p1/apps/upload");
    expect(urls[0].searchParams.get("region")).toBe("us-east-1");
  });

  it("keeps an explicit --region", async () => {
    await deploy({ region: "eu-west-lim-a" });
    expect(urls[0].searchParams.get("region")).toBe("eu-west-lim-a");
  });

  it("sends no region when uploading to an existing service", async () => {
    await deploy({ existingServiceId: "a1" });
    expect(urls[0].searchParams.get("appId")).toBe("a1");
    expect(urls[0].searchParams.has("region")).toBe(false);
  });
});
