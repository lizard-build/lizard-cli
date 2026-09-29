import { beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { registerSandbox } from "../../src/commands/sandbox.js";
import { api } from "../../src/lib/api.js";

vi.mock("../../src/lib/api.js", () => ({ api: { post: vi.fn() } }));
vi.mock("../../src/lib/config.js", () => ({
  resolveProjectId: vi.fn().mockResolvedValue("project-test"),
}));
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
  it.each(["pause", "resume", "fork", "snapshot", "restore", "snapshot-fork"])(
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
