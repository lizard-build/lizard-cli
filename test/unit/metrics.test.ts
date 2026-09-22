import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { registerMetrics } from "../../src/commands/metrics.js";
import { api } from "../../src/lib/api.js";
import { getProjectLink } from "../../src/lib/config.js";
import { getActiveServiceWithKind, resolveProjectScope } from "../../src/lib/resolve.js";
import { isJSONMode, printJSON, table } from "../../src/lib/format.js";

vi.mock("../../src/lib/api.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/lib/api.js")>(),
  api: { get: vi.fn() },
}));
vi.mock("../../src/lib/config.js", () => ({ getProjectLink: vi.fn() }));
vi.mock("../../src/lib/resolve.js", () => ({
  resolveProjectScope: vi.fn(),
  getActiveServiceWithKind: vi.fn(),
}));
vi.mock("../../src/lib/format.js", () => ({
  isJSONMode: vi.fn(),
  printJSON: vi.fn(),
  table: vi.fn(),
  info: vi.fn(),
  timeAgo: () => "1s ago",
  fail: (message: string): never => { throw new Error(message); },
}));

const services = ["web", "api", "postgres"].map((name) => ({
  id: name,
  label: name,
  type: name === "postgres" ? "addon" : "app",
  deleted: false,
  series: [],
  latest: { cpu: 0.1, memUsedMb: 128, memTotalMb: 512, sampledAt: 1 },
  limits: { cpuMillis: 1000, memoryMi: 512 },
}));

function run(args: string[]) {
  const program = new Command().exitOverride();
  registerMetrics(program);
  return program.parseAsync(["metrics", ...args], { from: "user" });
}

describe("metrics service selection", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(isJSONMode).mockReturnValue(true);
    vi.mocked(getProjectLink).mockReturnValue({
      projectId: "project-test", projectName: "test", serviceId: "web", serviceName: "web",
    });
    vi.mocked(resolveProjectScope).mockImplementation(async (project) => ({
      projectId: project ?? "project-test", scope: { workspaceId: "workspace-test" },
    }));
    vi.mocked(getActiveServiceWithKind).mockImplementation(async (service) => ({
      id: service ?? "web", name: service ?? "web", kind: "app",
    }));
    vi.mocked(api.get).mockResolvedValue({ services });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it.each([{ args: [] }, { args: ["-p", "other-project"] }])("--all ignores a linked service: $args", async ({ args }) => {
    await run(["--all", ...args]);
    expect(getActiveServiceWithKind).not.toHaveBeenCalled();
    expect(api.get).toHaveBeenCalledExactlyOnceWith(
      `/api/projects/${args.length ? "other-project" : "project-test"}/metrics?live=true&workspaceId=workspace-test`,
    );
    expect(printJSON).toHaveBeenCalledWith({ services });
  });

  it.each([{ args: [] }, { args: ["-s", "api"] }])("keeps service detail without --all: $args", async ({ args }) => {
    const detail = { series: [], latest: null, limits: { cpuMillis: 1000, memoryMi: 512 } };
    vi.mocked(api.get).mockResolvedValue(detail);
    await run(args);
    const name = args.length ? "api" : "web";
    expect(api.get).toHaveBeenCalledWith(`/api/apps/${name}/metrics?range=1h`);
    expect(printJSON).toHaveBeenCalledWith({
      service: { id: name, name, kind: "app" }, range: "1h", ...detail,
    });
  });

  it("keeps the project overview when no service is linked", async () => {
    vi.mocked(getProjectLink).mockReturnValue(null);
    await run([]);
    expect(printJSON).toHaveBeenCalledWith({ services });
  });

  it.each([{ args: ["--all", "-s", "web"] }, { args: ["--service", "api", "--all", "--watch"] }])(
    "rejects conflicting selectors before any request: $args", async ({ args }) => {
      await expect(run(args)).rejects.toThrow("--all cannot be combined with --service");
      expect(resolveProjectScope).not.toHaveBeenCalled();
      expect(api.get).not.toHaveBeenCalled();
    },
  );

  it("keeps the --watch JSON guard with --all", async () => {
    await expect(run(["--all", "--watch"])).rejects.toThrow("--watch is interactive");
    expect(api.get).not.toHaveBeenCalled();
  });

  it.each([true, false])("watch with all=%s selects the right services", async (all) => {
    vi.useFakeTimers();
    vi.mocked(isJSONMode).mockReturnValue(false);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stop = new Error("stop watch");
    vi.mocked(api.get).mockResolvedValueOnce({ services }).mockRejectedValueOnce(stop);
    const pending = run(all ? ["--all", "--watch"] : ["--watch"]);
    const stopped = expect(pending).rejects.toThrow("stop watch");
    await vi.advanceTimersByTimeAsync(3000);
    await stopped;
    const rows = vi.mocked(table).mock.calls[0][1];
    expect(rows.map((row) => row[0])).toEqual(all ? ["web", "api", "postgres"] : ["web"]);
    expect(getActiveServiceWithKind).toHaveBeenCalledTimes(all ? 0 : 1);
  });
});
