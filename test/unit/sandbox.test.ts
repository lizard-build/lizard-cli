import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { registerSandbox, lifetimeLine, sandboxNextSteps } from "../../src/commands/sandbox.js";
import { api, APIError } from "../../src/lib/api.js";
import { printJSON, warn } from "../../src/lib/format.js";
import { getProjectLink, resolveProjectId } from "../../src/lib/config.js";

vi.mock("../../src/lib/api.js", () => {
  class APIError extends Error {
    constructor(public status: number, message: string, public code = "", public body: unknown = null) { super(message); }
  }
  return { api: { post: vi.fn(), get: vi.fn(), delete: vi.fn() }, APIError };
});
vi.mock("open", () => ({ default: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../src/lib/config.js", () => ({
  resolveProjectId: vi.fn().mockResolvedValue("project-test"),
  getProjectLink: vi.fn(() => ({ projectId: "project-test" })),
  looksLikeId: (v: string) => /^[A-Za-z0-9_-]{21}$/.test(v) && /[A-Z]/.test(v),
  DEFAULT_REGION: "us-east-1",
}));
vi.mock("../../src/lib/format.js", () => ({ isJSONMode: () => true, printJSON: vi.fn(), warn: vi.fn() }));

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


describe("sandbox create size", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.post).mockResolvedValue({ id: "sandbox-test" });
  });

  it.each(["nano", "mini", "small", "medium", "large"])("sends --size %s to the API", async (size) => {
    await create(["--size", size]);
    expect(api.post).toHaveBeenCalledWith("/api/sandboxes", expect.objectContaining({ size }));
  });

  it("rejects an unknown size before making a request", async () => {
    await expect(create(["--size", "tiny"])).rejects.toThrow(/nano, mini, small, medium, large|"nano", "mini", "small", "medium", "large"/);
    expect(api.post).not.toHaveBeenCalled();
  });

  it("lists every size, Nano and Mini included, in the help", () => {
    const program = new Command();
    registerSandbox(program);
    const createCmd = program.commands.find((c) => c.name() === "sandbox")!.commands.find((c) => c.name() === "create")!;
    const help = createCmd.helpInformation().replace(/\s+/g, " ");
    expect(help).toContain("nano 0.5 vCPU/1 GB RAM/5 GB disk, mini 1/2/5, small 2/4/20, medium 4/8/40, large 8/16/80");
    expect(help).toContain("Nano only with base, claude and codex");
    expect(help).toContain("Mini works only with the base, claude, codex and interpreter templates");
    expect(help).toContain('(choices: "nano", "mini", "small", "medium", "large")');
  });
});

describe("sandbox create without a project", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.post).mockResolvedValue({ id: "sandbox-test" });
  });

  it("an unlinked folder sends no project and leaves the choice to the platform", async () => {
    vi.mocked(getProjectLink).mockReturnValueOnce(null);
    await create([]);
    expect(resolveProjectId).not.toHaveBeenCalled();
    expect(api.post).toHaveBeenCalledWith("/api/sandboxes", expect.objectContaining({ projectId: undefined }));
  });

  it("a linked folder or --project still sends its project", async () => {
    await create([]);
    expect(api.post).toHaveBeenCalledWith("/api/sandboxes", expect.objectContaining({ projectId: "project-test" }));
    vi.mocked(getProjectLink).mockReturnValueOnce(null);
    await create(["--project", "web"]);
    expect(resolveProjectId).toHaveBeenLastCalledWith("web");
  });

  it("an unlinked --volume still resolves a project, since a volume name lives in one", async () => {
    vi.mocked(getProjectLink).mockReturnValueOnce(null);
    await create(["--volume", "data"]);
    expect(resolveProjectId).toHaveBeenCalledWith(undefined);
    expect(api.post).toHaveBeenCalledWith("/api/sandboxes", expect.objectContaining({ projectId: "project-test", volumeName: "data" }));
  });

  it("a platform that still wants a project gets the old message", async () => {
    vi.mocked(getProjectLink).mockReturnValueOnce(null);
    vi.mocked(api.post).mockRejectedValueOnce(new APIError(400, "A project is required", "PROJECT_REQUIRED"));
    await expect(create([])).rejects.toThrow("No project linked. Run `lizard init` or pass --project <id>.");
  });
});

describe("sandbox create region", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.post).mockResolvedValue({ id: "sandbox-test" });
  });

  const regionSent = (call = 0) => (vi.mocked(api.post).mock.calls[call][1] as { region?: string }).region;
  const paused = () => new APIError(503, "New sandboxes are not available in US East (Virginia).", "region_unavailable");

  it("defaults to us-east-1", async () => {
    await create([]);
    expect(regionSent()).toBe("us-east-1");
  });

  it("sends --region as given", async () => {
    await create(["--region", "eu-west-lim-a"]);
    expect(regionSent()).toBe("eu-west-lim-a");
  });

  it.each([["--volume", "data"], ["--snapshot", "snap-1"]])("leaves the region to the platform with %s", async (...flag) => {
    await create(flag);
    expect(regionSent()).toBeUndefined();
  });

  it("asks again without a region when the default one is paused", async () => {
    vi.mocked(api.post).mockRejectedValueOnce(paused()).mockResolvedValueOnce({ id: "sandbox-test" });
    await create([]);
    expect(api.post).toHaveBeenCalledTimes(2);
    expect(regionSent(1)).toBeUndefined();
  });

  it("does not move a region the user named", async () => {
    vi.mocked(api.post).mockRejectedValueOnce(paused());
    await expect(create(["--region", "us-east-1"])).rejects.toThrow(/not available/);
    expect(api.post).toHaveBeenCalledTimes(1);
  });
});

describe("unsupported sandbox commands", () => {
  it.each(["snapshot-fork", "logs"])(
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

function sandboxCmd(args: string[]) {
  const program = new Command().exitOverride().configureOutput({ writeErr: () => {} });
  registerSandbox(program);
  return program.parseAsync(["sandbox", ...args], { from: "user" });
}

describe("sandbox rm aliases", () => {
  beforeEach(() => { vi.clearAllMocks(); vi.mocked(api.delete).mockResolvedValue(undefined); });

  it.each(["rm", "delete", "kill"])("%s deletes the sandbox", async (name) => {
    await sandboxCmd([name, "brave-otter-1234", "-y"]);
    expect(api.delete).toHaveBeenCalledWith("/api/sandboxes/brave-otter-1234");
    expect(printJSON).toHaveBeenCalledWith({ id: "brave-otter-1234", status: "deleted" });
  });
});

describe("sandbox fork", () => {
  const copy = (id: string) => ({ sandbox: { sandboxId: id, id, status: "running", forkedFrom: "src-1234" } });
  beforeEach(() => { vi.clearAllMocks(); process.exitCode = undefined; });
  afterEach(() => { process.exitCode = undefined; });

  it("asks for one copy with the source's lifetime by default", async () => {
    vi.mocked(api.post).mockResolvedValue([copy("a-1")]);
    await sandboxCmd(["fork", "src-1234"]);
    expect(api.post).toHaveBeenCalledWith("/api/sandboxes/src-1234/fork", { count: 1, timeoutMs: undefined });
    expect(printJSON).toHaveBeenCalledWith([copy("a-1")]);
    expect(process.exitCode).toBeUndefined();
  });

  it("sends --count and --timeout", async () => {
    vi.mocked(api.post).mockResolvedValue([copy("a-1"), copy("a-2"), copy("a-3")]);
    await sandboxCmd(["fork", "src-1234", "-n", "3", "--timeout", "900000"]);
    expect(api.post).toHaveBeenCalledWith("/api/sandboxes/src-1234/fork", { count: 3, timeoutMs: 900_000 });
    expect(process.exitCode).toBeUndefined();
  });

  it("prints a partial result and exits 1 when some copies could not start", async () => {
    const results = [copy("a-1"), { error: "Sandbox limit reached" }];
    vi.mocked(api.post).mockResolvedValue(results);
    await sandboxCmd(["fork", "src-1234", "--count", "2"]);
    expect(printJSON).toHaveBeenCalledWith(results);
    expect(process.exitCode).toBe(1);
  });

  it.each(["0", "101", "1.5", "two"])("rejects --count %s before making a request", async (n) => {
    await expect(sandboxCmd(["fork", "src-1234", "--count", n])).rejects.toThrow(/Count must be/);
    expect(api.post).not.toHaveBeenCalled();
  });

  it.each(["0", "999", "2147483648", "1h"])("rejects --timeout %s, since 0 would mean the source's lifetime", async (ms) => {
    await expect(sandboxCmd(["fork", "src-1234", "--timeout", ms])).rejects.toThrow(/Timeout must be/);
    expect(api.post).not.toHaveBeenCalled();
  });
});

describe("private sandbox snapshots", () => {
  beforeEach(() => { vi.clearAllMocks(); vi.mocked(api.post).mockResolvedValue({ id: 'snap-test', status: 'building' }); });
  it("creates a snapshot without a pool size", async () => {
    const program = new Command().exitOverride(); registerSandbox(program);
    await program.parseAsync(['sandbox', 'snapshot', 'sandbox-test', '--name', 'My app', '--no-wait'], { from: 'user' });
    // Never a scope: every snapshot restores only in its own project.
    expect(api.post).toHaveBeenCalledWith('/api/sandboxes/sandbox-test/snapshot', { name: 'My app' });
    expect(warn).not.toHaveBeenCalled();
  });
  it.each([['--full'], ['--fast']])("snapshot still takes %s from older scripts and sends no memory choice", async flag => {
    const program = new Command().exitOverride(); registerSandbox(program);
    await program.parseAsync(['sandbox', 'snapshot', 'sandbox-test', '--name', 'My app', flag, '--no-wait'], { from: 'user' });
    expect(api.post).toHaveBeenCalledWith('/api/sandboxes/sandbox-test/snapshot', { name: 'My app' });
  });
  it.each(['user', 'workspace'])("still takes --scope %s from older scripts, warns and sends no scope", async scope => {
    const program = new Command().exitOverride(); registerSandbox(program);
    await program.parseAsync(['sandbox', 'snapshot', 'sandbox-test', '--name', 'My app', '--scope', scope, '--no-wait'], { from: 'user' });
    expect(api.post).toHaveBeenCalledWith('/api/sandboxes/sandbox-test/snapshot', { name: 'My app' });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/only in its own project/));
  });
  it("takes --scope project quietly", async () => {
    const program = new Command().exitOverride(); registerSandbox(program);
    await program.parseAsync(['sandbox', 'snapshot', 'sandbox-test', '--name', 'My app', '--scope', 'project', '--no-wait'], { from: 'user' });
    expect(api.post).toHaveBeenCalledWith('/api/sandboxes/sandbox-test/snapshot', { name: 'My app' });
    expect(warn).not.toHaveBeenCalled();
  });
  it("hides --scope and snapshot-scope from help", () => {
    const program = new Command().exitOverride(); registerSandbox(program);
    const sandbox = program.commands.find(c => c.name() === 'sandbox')!;
    const snapshot = sandbox.commands.find(c => c.name() === 'snapshot')!;
    expect(snapshot.helpInformation()).not.toMatch(/--scope/);
    expect(sandbox.helpInformation()).not.toMatch(/snapshot-scope/);
  });
  it.each(['user', 'workspace', 'project'])("snapshot-scope %s changes nothing, calls no API and succeeds", async scope => {
    const program = new Command().exitOverride(); registerSandbox(program);
    await program.parseAsync(['sandbox', 'snapshot-scope', 'snap-test', scope], { from: 'user' });
    expect(api.post).not.toHaveBeenCalled();
    expect(api.get).not.toHaveBeenCalled();
    expect(printJSON).toHaveBeenCalledWith({ id: 'snap-test', scope: 'project', message: expect.stringMatching(/only in its own project/) });
  });
  it("snapshot-scope still refuses an unknown scope", async () => {
    const program = new Command().exitOverride().configureOutput({ writeErr: () => {} }); registerSandbox(program);
    await expect(program.parseAsync(['sandbox', 'snapshot-scope', 'snap-test', 'team'], { from: 'user' })).rejects.toThrow(/Scope must be one of/);
    expect(printJSON).not.toHaveBeenCalled();
  });
  it("no longer takes --warm", async () => {
    const program = new Command().exitOverride(); registerSandbox(program);
    await expect(program.parseAsync(['sandbox', 'snapshot', 'sandbox-test', '--name', 'app', '--warm', '3', '--no-wait'], { from: 'user' })).rejects.toThrow(/unknown option/);
    expect(api.post).not.toHaveBeenCalled();
  });
  it.each(['0', '11', '1.5', '5junk'])("snapshot-warm rejects invalid count %s", async count => {
    const program = new Command().exitOverride(); registerSandbox(program);
    await expect(program.parseAsync(['sandbox', 'snapshot-warm', 'snap-test', count], { from: 'user' })).rejects.toThrow(/Warm copies/);
  });
  it.each(['pause', 'resume'])("queues %s without waiting when requested", async operation => {
    const program = new Command().exitOverride(); registerSandbox(program);
    await program.parseAsync(['sandbox', operation, 'sandbox-test', '--no-wait'], { from: 'user' });
    expect(api.post).toHaveBeenCalledWith(`/api/sandboxes/sandbox-test/${operation}`, {});
  });
  // Memory pauses are off: every pause is the platform's default (files only); the old flags
  // are still accepted so older scripts run, and send nothing.
  it.each([[[]], [['--full']], [['--fast']], [['--full', '--fast']]])("pause %j sends the default pause", async flags => {
    const program = new Command().exitOverride(); registerSandbox(program);
    await program.parseAsync(['sandbox', 'pause', 'sandbox-test', ...flags as string[], '--no-wait'], { from: 'user' });
    expect(api.post).toHaveBeenCalledWith('/api/sandboxes/sandbox-test/pause', {});
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

describe("after sandbox create", () => {
  const plain = (t: string) => t.replace(/\x1b\[[0-9;]*m/g, "");

  it("says when the sandbox is deleted, and how to keep it", () => {
    const now = Date.parse("2026-10-12T12:00:00Z");
    const line = lifetimeLine("2026-10-12T12:05:00Z", now);
    expect(line).toMatch(/^Lifetime: 5 min, then it is deleted with its files \(at .+\)$/);
    expect(line.length + 2).toBeLessThanOrEqual(80);
    expect(lifetimeLine("2026-10-12T14:00:00Z", now)).toMatch(/^Lifetime: 2 h, then/);
    expect(lifetimeLine(null, now)).toBe("Lifetime: no limit. It runs until you delete it.");
  });

  it("lists what to do next with the id filled in, within 80 columns", () => {
    const lines = plain(sandboxNextSteps("defense-wise-7ibp")).split("\n");
    expect(lines[0]).toBe("Next");
    expect(lines.slice(1).map((l) => l.trim().split(/\s{2,}/)[0])).toEqual([
      "lizard sandbox ssh defense-wise-7ibp",
      "lizard sandbox exec defense-wise-7ibp -- uname -a",
      "lizard sandbox expose defense-wise-7ibp 3000",
      "lizard sandbox timeout defense-wise-7ibp 3600000",
      "lizard sandbox rm defense-wise-7ibp",
    ]);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(80);
  });
});

describe("sandbox cpu", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reads the platform's answer and prints it as JSON", async () => {
    const answer = { id: "gap-lizard-pn10", model: "AMD EPYC 7351P 16-Core Processor", source: "host", vcpus: 2 };
    vi.mocked(api.get).mockResolvedValue(answer);
    const program = new Command().exitOverride();
    registerSandbox(program);
    await program.parseAsync(["sandbox", "cpu", "gap-lizard-pn10"], { from: "user" });
    expect(api.get).toHaveBeenCalledWith("/api/sandboxes/gap-lizard-pn10/cpu");
    expect(printJSON).toHaveBeenCalledWith(answer);
  });
});

describe("sandbox cpu in a terminal", () => {
  afterEach(() => vi.restoreAllMocks());

  it("prints the name without control characters", async () => {
    vi.resetModules();
    vi.doMock("../../src/lib/format.js", () => ({ isJSONMode: () => false, printJSON: vi.fn(), info: vi.fn(), success: vi.fn(), error: vi.fn(), table: vi.fn(), statusColor: (s: string) => s, timeAgo: () => "", isTTY: () => true }));
    const { registerSandbox: register } = await import("../../src/commands/sandbox.js");
    const { api: mockedApi } = await import("../../src/lib/api.js");
    vi.mocked(mockedApi.get).mockResolvedValue({ id: "s", model: "AMD\u001b]52;c;eA==\u0007 EPYC", source: "guest", vcpus: 2 });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = new Command().exitOverride();
    register(program);
    await program.parseAsync(["sandbox", "cpu", "s"], { from: "user" });
    expect(log).toHaveBeenCalledWith("AMD ]52;c;eA==  EPYC");
    vi.doUnmock("../../src/lib/format.js");
  });
});
