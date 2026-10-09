import { beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { registerVolume } from "../../src/commands/volume.js";
import { api, APIError } from "../../src/lib/api.js";
import { isJSONMode, printJSON, warn } from "../../src/lib/format.js";

vi.mock("../../src/lib/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/api.js")>();
  return { ...actual, api: { get: vi.fn(), patch: vi.fn() } };
});
vi.mock("../../src/lib/resolve.js", () => ({
  resolveProjectScope: vi.fn().mockResolvedValue({ projectId: "project-test", scope: { workspaceId: "workspace-test" } }),
}));
vi.mock("../../src/lib/format.js", () => ({
  isJSONMode: vi.fn(() => true),
  printJSON: vi.fn(),
  success: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  table: vi.fn(),
  isTTY: () => false,
}));

const VOLUME = { id: "Vx1234567890abcdefghi", name: "build-cache", sizeGb: 5, status: "ready" };

function resize(args: string[]) {
  const program = new Command().exitOverride();
  registerVolume(program);
  return program.parseAsync(["volume", "resize", ...args], { from: "user" });
}

describe("volume resize", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isJSONMode).mockReturnValue(true);
    vi.mocked(api.get).mockResolvedValue(VOLUME);
    vi.mocked(api.patch).mockResolvedValue({ ...VOLUME, sizeGb: 10, sizeEnforced: true });
  });

  it("PATCHes the volume by name with the new size and prints the result", async () => {
    await resize(["build-cache", "--size", "10"]);
    expect(api.patch).toHaveBeenCalledWith(
      "/api/projects/project-test/volumes/build-cache?workspaceId=workspace-test",
      { sizeGb: 10 },
    );
    expect(printJSON).toHaveBeenCalledWith(expect.objectContaining({ sizeGb: 10, sizeEnforced: true }));
  });

  it("resolves a volume given by ID and addresses the PATCH by its name", async () => {
    await resize([VOLUME.id, "--size", "10"]);
    expect(api.get).toHaveBeenCalledWith(
      `/api/projects/project-test/volumes/${VOLUME.id}?workspaceId=workspace-test`,
    );
    expect(api.patch).toHaveBeenCalledWith(
      "/api/projects/project-test/volumes/build-cache?workspaceId=workspace-test",
      { sizeGb: 10 },
    );
  });

  it("allows a shrink", async () => {
    vi.mocked(api.patch).mockResolvedValue({ ...VOLUME, sizeGb: 2 });
    await resize(["build-cache", "--size", "2"]);
    expect(api.patch).toHaveBeenCalledWith(expect.any(String), { sizeGb: 2 });
  });

  it("surfaces the Firecracker grow-only refusal", async () => {
    vi.mocked(api.patch).mockRejectedValue(
      new APIError(400, "A volume can only grow (it is 5 GB)", "volume_shrink_unsupported"),
    );
    await expect(resize(["build-cache", "--size", "2"])).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(/only grow/),
    });
  });

  it("warns when an attached sandbox's file system did not grow", async () => {
    vi.mocked(isJSONMode).mockReturnValue(false);
    vi.mocked(api.get).mockResolvedValue({ ...VOLUME, attachedTo: "sbx-1" });
    vi.mocked(api.patch).mockResolvedValue({ ...VOLUME, attachedTo: "sbx-1", sizeGb: 10, grownInSandbox: false });
    await resize(["build-cache", "--size", "10"]);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/sandbox sbx-1 still shows the old size/));
  });

  it("does not warn when the volume is detached or grew in the sandbox", async () => {
    vi.mocked(isJSONMode).mockReturnValue(false);
    vi.mocked(api.patch).mockResolvedValue({ ...VOLUME, sizeGb: 10, grownInSandbox: false });
    await resize(["build-cache", "--size", "10"]);
    vi.mocked(api.get).mockResolvedValue({ ...VOLUME, attachedTo: "sbx-1" });
    vi.mocked(api.patch).mockResolvedValue({ ...VOLUME, attachedTo: "sbx-1", sizeGb: 10, grownInSandbox: true });
    await resize(["build-cache", "--size", "10"]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("makes no request when the size is unchanged", async () => {
    await resize(["build-cache", "--size", "5"]);
    expect(api.patch).not.toHaveBeenCalled();
    expect(printJSON).toHaveBeenCalledWith(VOLUME);
  });

  it("surfaces the server's error message", async () => {
    vi.mocked(api.patch).mockRejectedValue(
      new APIError(409, "Volume has 4.8 GB used; shrinking to 5 GB would leave less than 10% free", "volume_too_full_to_shrink"),
    );
    await expect(resize(["build-cache", "--size", "3"])).rejects.toMatchObject({
      status: 409,
      code: "volume_too_full_to_shrink",
      message: expect.stringMatching(/less than 10% free/),
    });
  });

  it.each(["0", "-1", "1.5", "ten"])("rejects --size %s before making a request", async (value) => {
    await expect(resize(["build-cache", "--size", value])).rejects.toThrow(/--size|Invalid number/);
    expect(api.get).not.toHaveBeenCalled();
    expect(api.patch).not.toHaveBeenCalled();
  });

  it("requires --size", async () => {
    await expect(resize(["build-cache"])).rejects.toThrow();
    expect(api.patch).not.toHaveBeenCalled();
  });
});
