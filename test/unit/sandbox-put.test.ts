import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { putSandboxFile } from "../../src/commands/sandbox.js";
import { api } from "../../src/lib/api.js";

vi.mock("../../src/lib/api.js", () => ({ api: { post: vi.fn() }, APIError: class extends Error {} }));
vi.mock("../../src/lib/format.js", () => ({ isJSONMode: () => true, isTTY: () => false }));

/** A fake sandbox: POST /files writes into `files`, POST /exec runs the few scripts put uses. */
function fakeSandbox(failAt?: number) {
  const files = new Map<string, Buffer>();
  let writes = 0;
  vi.mocked(api.post).mockImplementation(async (url: string, body: any) => {
    if (url.endsWith("/files")) {
      if (++writes === failAt) throw new Error("413");
      files.set(body.path, Buffer.from(body.content, "base64"));
      return { status: "written" };
    }
    const [, , script, , ...a] = body.cmd as string[];
    if (script.startsWith("mkdir")) files.set(a[0], Buffer.alloc(0));
    else if (script.startsWith("cat")) { files.set(a[1], Buffer.concat([files.get(a[1])!, files.get(a[0])!])); files.delete(a[0]); }
    else if (script.startsWith("[")) {
      if (files.get(a[0])!.length !== Number(a[1])) return { exitCode: 1, stderr: "size" };
      files.set(a[2], files.get(a[0])!); files.delete(a[0]);
    } else if (script.startsWith("rm")) a.forEach((f) => files.delete(f));
    return { exitCode: 0 };
  });
  return files;
}

describe("sandbox files put", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "put-")); vi.mocked(api.post).mockReset(); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("sends a small file in one request", async () => {
    const files = fakeSandbox();
    fs.writeFileSync(path.join(dir, "a"), "hello");
    expect(await putSandboxFile("sb", path.join(dir, "a"), "/w/a")).toBe(5);
    expect(api.post).toHaveBeenCalledTimes(1);
    expect(files.get("/w/a")!.toString()).toBe("hello");
  });

  it("sends a big file in pieces and joins them in order", async () => {
    const files = fakeSandbox();
    const data = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251));
    fs.writeFileSync(path.join(dir, "b"), data);
    expect(await putSandboxFile("sb", path.join(dir, "b"), "/w/b", 300, 100)).toBe(1000);
    expect(files.get("/w/b")!.equals(data)).toBe(true);
    expect([...files.keys()]).toEqual(["/w/b"]);
  });

  it("leaves nothing behind when a piece fails", async () => {
    const files = fakeSandbox(2);
    fs.writeFileSync(path.join(dir, "c"), Buffer.alloc(1000, 7));
    await expect(putSandboxFile("sb", path.join(dir, "c"), "/w/c", 300, 100)).rejects.toThrow("413");
    expect(files.size).toBe(0);
  });
});
