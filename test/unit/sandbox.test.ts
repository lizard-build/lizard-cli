import { beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { registerSandbox } from "../../src/commands/sandbox.js";
import { api, APIError } from "../../src/lib/api.js";
import { printJSON } from "../../src/lib/format.js";

vi.mock("../../src/lib/api.js", () => {
  class APIError extends Error {
    constructor(public status: number, message: string, public code = "", public body: unknown = null) { super(message); }
  }
  return { api: { post: vi.fn(), get: vi.fn(), delete: vi.fn() }, APIError };
});
vi.mock("open", () => ({ default: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../src/lib/config.js", () => ({
  resolveProjectId: vi.fn().mockResolvedValue("project-test"),
}));
vi.mock("../../src/lib/config.js", () => ({ resolveProjectId: vi.fn().mockResolvedValue("project-test") }));
vi.mock("../../src/lib/format.js", () => ({ isJSONMode: () => true, printJSON: vi.fn() }));

function create(args: string[]) {
  const program = new Command().exitOverride();
  registerSandbox(program);
  return program.parseAsync(["sandbox", "create", ...args], { from: "user" });
}

describe("sandbox create timeout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.post).mockResolvedValue({ id: "sandbox-test" });
  });

  it("sends the documented five-minute default to the API", async () => {
    await create([]);
    expect(api.post).toHaveBeenCalledWith("/api/sandboxes", expect.objectContaining({ timeoutMs: 300_000 }));
  });

  it.each([0, 1000, 120_000, 2_147_483_647])("preserves an explicit timeout of %i", async (timeoutMs) => {
    await create(["--timeout", String(timeoutMs)]);
    expect(api.post).toHaveBeenCalledWith("/api/sandboxes", expect.objectContaining({ timeoutMs }));
  });

  it.each(["-1", "1.5", "1000ms", "Infinity", "2147483648"])("rejects %s before making a request", async (value) => {
    await expect(create(["--timeout", value])).rejects.toThrow(/Timeout must be/);
    expect(api.post).not.toHaveBeenCalled();
  });
});


describe("unsupported sandbox commands", () => {
  it.each(["fork", "snapshot-fork", "logs"])(
    "rejects %s without making an API request", async (name) => {
      vi.clearAllMocks();
      const program = new Command().exitOverride().configureOutput({ writeErr: () => {} });
      registerSandbox(program);
      const sandbox = program.commands.find(command => command.name() === "sandbox")!;
      expect(sandbox.commands.flatMap(command => [command.name(), ...command.aliases()])).not.toContain(name);
      await expect(program.parseAsync(["sandbox", name, "test-id"], { from: "user" }))
        .rejects.toMatchObject({ code: "commander.unknownCommand" });
      expect(api.post).not.toHaveBeenCalled();
    }
  );
});

describe("private sandbox snapshots", () => {
  beforeEach(() => { vi.clearAllMocks(); vi.mocked(api.post).mockResolvedValue({ id: 'snap-test', status: 'building' }); });
  it("creates a snapshot with five warm copies by default", async () => {
    const program = new Command().exitOverride(); registerSandbox(program);
    await program.parseAsync(['sandbox', 'snapshot', 'sandbox-test', '--name', 'My app', '--no-wait'], { from: 'user' });
    expect(api.post).toHaveBeenCalledWith('/api/sandboxes/sandbox-test/snapshot', { name: 'My app', poolSize: 5 });
  });
  it.each(['0', '11', '1.5', '5junk'])("rejects invalid warm count %s", async count => {
    const program = new Command().exitOverride(); registerSandbox(program);
    await expect(program.parseAsync(['sandbox', 'snapshot', 'sandbox-test', '--name', 'app', '--warm', count, '--no-wait'], { from: 'user' })).rejects.toThrow(/Warm copies/);
    expect(api.post).not.toHaveBeenCalled();
  });
  it.each(['pause', 'resume'])("queues %s without waiting when requested", async operation => {
    const program = new Command().exitOverride(); registerSandbox(program);
    await program.parseAsync(['sandbox', operation, 'sandbox-test', '--no-wait'], { from: 'user' });
    expect(api.post).toHaveBeenCalledWith(`/api/sandboxes/sandbox-test/${operation}`, {});
  });
  it("passes the private snapshot ID to create", async () => {
    await create(['--snapshot', 'snap-test']);
    expect(api.post).toHaveBeenCalledWith('/api/sandboxes', expect.objectContaining({ snapshotId: 'snap-test' }));
  });
});


describe("snapshot pause and resume", () => {
  it.each(["pause", "resume"])("sends snapshot %s to its own lifecycle endpoint", async operation => {
    vi.clearAllMocks();
    vi.mocked(api.post).mockResolvedValue({ id: "snap-test", status: operation === "pause" ? "paused" : "warming" });
    const program = new Command().exitOverride();
    registerSandbox(program);
    await program.parseAsync(["sandbox", `snapshot-${operation}`, "snap-test"], { from: "user" });
    expect(api.post).toHaveBeenCalledWith(`/api/sandbox-snapshots/snap-test/${operation}`, {});
  });
});


describe("sandbox desktop", () => {
  const desktop = { running: true, width: 1280, height: 800, url: "https://x/vnc.html?password=a", viewOnlyUrl: "https://x/vnc.html?password=b&view_only=true" };
  function run(args: string[]) {
    const program = new Command().exitOverride().configureOutput({ writeErr: () => {} });
    registerSandbox(program);
    return program.parseAsync(["sandbox", "desktop", "sb-test", ...args], { from: "user" });
  }
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.post).mockResolvedValue(desktop);
    vi.mocked(api.get).mockResolvedValue(desktop);
    vi.mocked(api.delete).mockResolvedValue({ running: false });
  });

  it("starts the desktop and prints the API response in JSON mode", async () => {
    await run([]);
    expect(api.post).toHaveBeenCalledWith("/api/sandboxes/sb-test/desktop", {});
    expect(printJSON).toHaveBeenCalledWith(desktop);
  });

  it("sends a validated --resolution as width/height", async () => {
    await run(["--resolution", "1920x1080"]);
    expect(api.post).toHaveBeenCalledWith("/api/sandboxes/sb-test/desktop", { width: 1920, height: 1080 });
  });

  it.each(["1920", "1920x", "abcx100", "639x480", "3841x1080", "1920x479", "1920x2161"])(
    "rejects resolution %s before making a request", async (value) => {
      await expect(run(["--resolution", value])).rejects.toThrow(/[Rr]esolution/);
      expect(api.post).not.toHaveBeenCalled();
    },
  );

  it("--status reads without starting", async () => {
    await run(["--status"]);
    expect(api.get).toHaveBeenCalledWith("/api/sandboxes/sb-test/desktop");
    expect(api.post).not.toHaveBeenCalled();
  });

  it("--stop deletes", async () => {
    await run(["--stop"]);
    expect(api.delete).toHaveBeenCalledWith("/api/sandboxes/sb-test/desktop");
    expect(printJSON).toHaveBeenCalledWith({ running: false });
  });

  it("rejects --stop with --status", async () => {
    await expect(run(["--stop", "--status"])).rejects.toThrow(/can't be combined/);
    expect(api.delete).not.toHaveBeenCalled();
  });

  it("points at `sandbox create -t desktop` when the template has no desktop", async () => {
    vi.mocked(api.post).mockRejectedValue(new APIError(400, "The 'base' template has no desktop.", "DESKTOP_NOT_SUPPORTED"));
    await expect(run([])).rejects.toMatchObject({ code: "DESKTOP_NOT_SUPPORTED", message: expect.stringContaining("lizard sandbox create -t desktop") });
  });
});
