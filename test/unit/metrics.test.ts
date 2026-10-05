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
  timestamps: [],
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
    expect(api.get).toHaveBeenCalledWith(
      `/api/projects/${args.length ? "other-project" : "project-test"}/metrics?live=true&workspaceId=workspace-test`,
    );
    expect(api.get).toHaveBeenCalledWith(
      `/api/projects/${args.length ? "other-project" : "project-test"}/metrics?range=1h&workspaceId=workspace-test`,
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
    vi.mocked(api.get).mockImplementation(async (path) => {
      if (String(path).includes("live=true") && vi.mocked(table).mock.calls.length) throw stop;
      return { services };
    });
    const pending = run(all ? ["--all", "--watch"] : ["--watch"]);
    const stopped = expect(pending).rejects.toThrow("stop watch");
    await vi.advanceTimersByTimeAsync(3000);
    await stopped;
    const rows = vi.mocked(table).mock.calls[0][1];
    expect(rows.map((row) => row[0])).toEqual(all ? ["web", "api", "postgres"] : ["web"]);
    expect(getActiveServiceWithKind).toHaveBeenCalledTimes(all ? 0 : 1);
  });

  function mockHistory(series: { metric: string; values: number[]; available?: boolean[] }[]) {
    vi.mocked(api.get).mockImplementation(async (path) => ({
      services: String(path).includes("live=true") ? services : [
        { ...services[0], latest: { ...services[0].latest, cpu: 99 }, series, timestamps: [1, 2] },
      ],
    }));
  }

  it("joins history by ID and keeps CPU/memory from the live snapshot", async () => {
    vi.mocked(isJSONMode).mockReturnValue(false);
    mockHistory([
      { metric: "network_tx", values: [0, 2048] },
      { metric: "disk_used", values: [0, 1024 ** 3] },
      { metric: "disk_total", values: [0, 10 * 1024 ** 3] },
    ]);
    await run(["--all"]);
    expect(table).toHaveBeenCalledWith(
      ["Service", "Type", "CPU (vCPU)", "Memory", "Egress", "Volumes", "Sampled"],
      expect.arrayContaining([
        ["web", "app", "0.10 / 1", "128.0 MB / 512.0 MB", "2.0 KB/s", "1.00 GB / 10.00 GB", "1s ago"],
      ]),
    );
  });

  it("keeps measured zero distinct from unavailable values", async () => {
    vi.mocked(isJSONMode).mockReturnValue(false);
    mockHistory([
      { metric: "network_tx", values: [100, 0] },
      { metric: "disk_used", values: [100, 0] },
      { metric: "disk_total", values: [1024, 1024] },
    ]);
    await run(["--all"]);
    const rows = vi.mocked(table).mock.calls[0][1];
    expect(rows[0].slice(4, 6)).toEqual(["0 B/s", "0 B / 1.0 KB"]);
    expect(rows[1][4]).toContain("—");
    expect(rows[1][5]).toContain("—");
  });

  it.each([
    { values: [10, 0], available: [true, false] },
    { values: [0] },
    { values: [] },
    { values: [0, NaN] },
    { values: [0, -1] },
  ])("does not display missing, invalid or synthetic egress as measured: %j", async (series) => {
    vi.mocked(isJSONMode).mockReturnValue(false);
    mockHistory([{ metric: "network_tx", ...series }]);
    await run(["--all"]);
    expect(vi.mocked(table).mock.calls[0][1][0][4]).toContain("—");
  });

  it("respects unavailable volume usage while showing known capacity", async () => {
    vi.mocked(isJSONMode).mockReturnValue(false);
    mockHistory([
      { metric: "disk_used", values: [100, 0], available: [true, false] },
      { metric: "disk_total", values: [1024, 1024] },
    ]);
    await run(["--all"]);
    expect(vi.mocked(table).mock.calls[0][1][0][5]).toContain("—");
    expect(vi.mocked(table).mock.calls[0][1][0][5]).toContain(" / 1.0 KB");
  });

  it("accepts a single measured rate from the current API", async () => {
    vi.mocked(isJSONMode).mockReturnValue(false);
    mockHistory([{ metric: "network_tx", values: [2048] }]);
    await run(["--all"]);
    expect(vi.mocked(table).mock.calls[0][1][0][4]).toBe("2.0 KB/s");
  });

  it("matches reordered sandbox/addon history by ID and excludes deleted services", async () => {
    vi.mocked(isJSONMode).mockReturnValue(false);
    const live = [
      { ...services[0], type: "sandbox" },
      { ...services[2], latest: null },
      { ...services[1], deleted: true },
    ];
    const series = [{ metric: "network_tx", values: [0, 1024] }];
    vi.mocked(api.get).mockImplementation(async (path) => ({ services:
      String(path).includes("live=true") ? live : [...live].reverse().map((s) => ({ ...s, series })),
    }));
    await run(["--all"]);
    const rows = vi.mocked(table).mock.calls[0][1];
    expect(rows.map((row) => row[0])).toEqual(["web", "postgres"]);
    expect(rows[0][4]).toBe("1.0 KB/s");
    expect(rows[1][4]).toContain("—");
  });

  it("includes I/O history in JSON without replacing live CPU", async () => {
    const series = [{ metric: "network_tx", values: [0, 2048] }];
    mockHistory(series);
    await run(["--all"]);
    expect(printJSON).toHaveBeenCalledWith({ services: [
      { ...services[0], series, timestamps: [1, 2] }, ...services.slice(1),
    ] });
  });

  it("still shows live metrics if history fails", async () => {
    vi.mocked(api.get).mockImplementation(async (path) => {
      if (String(path).includes("range=")) throw new Error("history unavailable");
      return { services };
    });
    await run(["--all"]);
    expect(printJSON).toHaveBeenCalledWith({ services });
  });

  it("refreshes history every 30s while polling live metrics every 3s", async () => {
    vi.useFakeTimers();
    vi.mocked(isJSONMode).mockReturnValue(false);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    let liveCalls = 0;
    let historyCalls = 0;
    vi.mocked(api.get).mockImplementation(async (path) => {
      if (String(path).includes("live=true")) {
        if (++liveCalls === 12) throw new Error("stop watch");
        return { services };
      }
      historyCalls++;
      return { services: [{ ...services[0], series: [
        { metric: "network_tx", values: [0, historyCalls * 1024] },
      ] }] };
    });
    const stopped = expect(run(["--all", "--watch"])).rejects.toThrow("stop watch");
    await vi.advanceTimersByTimeAsync(33_000);
    await stopped;
    expect(historyCalls).toBe(2);
    expect(vi.mocked(table).mock.calls[0][1][0][4]).toBe("1.0 KB/s");
    expect(vi.mocked(table).mock.calls[10][1][0][4]).toBe("2.0 KB/s");
  });
});

describe("metrics --cost", () => {
  const live = {
    resources: [{ projectId: "project-test", type: "app", name: "web", vcpu: 0.5, memoryGb: 0.5, storageGb: 0, costPerHour: 0.01 }],
    costPerHour: 0.02,
  };
  const prices = { cpuPerVcpuPerSec: 0.000005, memoryPerGbPerSec: 0.000002, storagePerGbPerSec: 0, egressPerGb: 0.05 };
  const summary = {
    projects: [{ projectId: "project-test", cpuVcpuSeconds: 3600, memoryGbSeconds: 3600, storageGbSeconds: 0, egressBytes: 0, costUsd: 0.03 }],
    periodStart: Date.now() - 86_400_000,
    periodEnd: Date.now() + 86_400_000,
    prices,
  };
  const period = { start: 1, end: 2, includedCents: 1900, usedCents: 3140, overageCents: 1240 };

  function mockCost(subscription: unknown) {
    vi.mocked(api.get).mockImplementation(async (path) => {
      const p = String(path);
      if (p.startsWith("/api/billing/live")) return live;
      if (p.startsWith("/api/billing/summary")) return summary;
      if (p.startsWith("/api/billing/account")) return { status: "active" };
      if (p.startsWith("/api/billing/subscription")) {
        if (subscription instanceof Error) throw subscription;
        return subscription;
      }
      return { apps: [], addons: [] };
    });
  }

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getProjectLink).mockReturnValue({ projectId: "project-test", projectName: "test" });
    vi.mocked(resolveProjectScope).mockResolvedValue({ projectId: "project-test", scope: { workspaceId: "workspace-test" } });
  });

  it("shows Pro credits used of $19 and the overage", async () => {
    vi.mocked(isJSONMode).mockReturnValue(false);
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { lines.push(a.join(" ")); });
    mockCost({ plan: "pro", status: "active", period: { kind: "paid", ...period } });
    await run(["--cost"]);
    expect(api.get).toHaveBeenCalledWith("/api/billing/subscription?workspaceId=workspace-test");
    expect(lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "")).toContain("Pro       $31.40 of $19 in monthly credits used, overage $12.40");
  });

  it("shows trial credits left during the trial", async () => {
    vi.mocked(isJSONMode).mockReturnValue(false);
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { lines.push(a.join(" ")); });
    mockCost({ plan: "pro", status: "trialing", period: { ...period, kind: "trial", includedCents: 500, usedCents: 120, overageCents: 0 } });
    await run(["--cost"]);
    expect(lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "")).toContain("Pro trial $1.20 of $5 in trial credits used, $3.80 left");
  });

  it("adds proCredits to JSON for Pro, and nothing for prepaid credits or older servers", async () => {
    vi.mocked(isJSONMode).mockReturnValue(true);
    mockCost({ plan: "pro", status: "active", period: { kind: "paid", ...period } });
    await run(["--cost"]);
    expect(vi.mocked(printJSON).mock.calls[0][0]).toMatchObject({
      proCredits: { status: "active", kind: "paid", periodStart: 1, periodEnd: 2, includedCents: 1900, usedCents: 3140, overageCents: 1240 },
    });

    for (const sub of [{ plan: "payg", status: "none", period: null }, new Error("404")]) {
      vi.mocked(printJSON).mockClear();
      mockCost(sub);
      await run(["--cost"]);
      const json = vi.mocked(printJSON).mock.calls[0][0] as Record<string, unknown>;
      expect(json).not.toHaveProperty("proCredits");
      expect(json).toMatchObject({ projectId: "project-test", workspaceCostPerHour: 0.02 });
    }
  });
});
