import { beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { registerSandbox } from "../../src/commands/sandbox.js";
import { api } from "../../src/lib/api.js";

vi.mock("../../src/lib/api.js", () => ({ api: { post: vi.fn() } }));
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
  it.each(["fork", "snapshot-fork"])(
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
