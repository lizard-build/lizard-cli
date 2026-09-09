import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { setBaseURL, getBaseURL } from "../../src/lib/api.js";
import { waitForAppReady } from "../../src/lib/wait-ready.js";

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

let server: http.Server;
let handle: Handler;
const originalBaseURL = getBaseURL();

beforeEach(async () => {
  server = http.createServer((req, res) => handle(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  setBaseURL(`http://127.0.0.1:${port}`);
});

afterEach(async () => {
  setBaseURL(originalBaseURL);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function json(res: http.ServerResponse, body: unknown) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

// A queue of app snapshots, one served per GET /api/apps/:id — the last entry
// repeats once the queue is drained, so a test only has to describe the
// interesting transitions.
function serveSequence(snapshots: any[]) {
  let i = 0;
  handle = (_req, res) => {
    const snap = snapshots[Math.min(i, snapshots.length - 1)];
    i++;
    json(res, snap);
  };
}

describe("waitForAppReady", () => {
  test("LIZARD-174: a stale already-running read from before the restart is not mistaken for success", async () => {
    // First poll still reflects the OLD attempt (status running, restartedAt
    // unchanged from baseline) — this is exactly the false positive the
    // baseline-diff exists to prevent. Only once restartedAt actually moves
    // and settles back to running should the wait resolve.
    serveSequence([
      { status: "running", deployStatus: "idle", restartedAt: 1000 }, // stale — must be ignored
      { status: "running", deployStatus: "idle", restartedAt: 1000 }, // still stale
      { status: "running", deployStatus: "restarting", restartedAt: 2000 }, // new attempt begins
      { status: "running", deployStatus: "restarting", restartedAt: 2000 },
      { status: "running", deployStatus: "idle", restartedAt: 2000 }, // new attempt ready
    ]);

    const result = await waitForAppReady("app1", 1000, { timeoutMs: 15_000, healthCheck: false });
    expect(result.ok).toBe(true);
    expect(result.status).toBe("running");
    expect(result.attemptId).toBe(2000);
  });

  test("reports failure for the new attempt (Pending -> CrashLoopBackOff)", async () => {
    serveSequence([
      { status: "running", deployStatus: "idle", restartedAt: 1000 },
      { status: "crashed", deployStatus: "restarting", restartedAt: 2000 },
      { status: "crashed", deployStatus: "idle", restartedAt: 2000 },
    ]);

    const result = await waitForAppReady("app1", 1000, { timeoutMs: 15_000, healthCheck: false });
    expect(result.ok).toBe(false);
    expect(result.status).toBe("crashed");
    expect(result.attemptId).toBe(2000);
  });

  test("times out with a non-ok result if the new attempt never settles", async () => {
    serveSequence([{ status: "running", deployStatus: "restarting", restartedAt: 2000 }]);

    const result = await waitForAppReady("app1", 1000, { timeoutMs: 2500, healthCheck: false });
    expect(result.ok).toBe(false);
    expect(result.status).toBe("timeout");
  });

  test("late start: keeps waiting through several restarting polls before success", async () => {
    serveSequence([
      { status: "running", deployStatus: "restarting", restartedAt: 2000 },
      { status: "running", deployStatus: "restarting", restartedAt: 2000 },
      { status: "running", deployStatus: "restarting", restartedAt: 2000 },
      { status: "running", deployStatus: "restarting", restartedAt: 2000 },
      { status: "running", deployStatus: "idle", restartedAt: 2000 },
    ]);

    const result = await waitForAppReady("app1", null, { timeoutMs: 15_000, healthCheck: false });
    expect(result.ok).toBe(true);
  });

  test("undefined baseline (redeploy) trusts deployStatus/status directly, no restartedAt gate", async () => {
    // redeploy never touches restartedAt — it stays null throughout, and that
    // must not block success the way a real restart's stale baseline would.
    serveSequence([
      { status: "running", deployStatus: "deploying", restartedAt: null },
      { status: "running", deployStatus: "idle", restartedAt: null },
    ]);

    const result = await waitForAppReady("app1", undefined, { timeoutMs: 15_000, healthCheck: false });
    expect(result.ok).toBe(true);
  });

  test("LIZARD-174: a containerPort=0 worker with a domain resolves without health-checking it", async () => {
    // Every app gets a generated .onlizard.com domain regardless of whether it
    // serves HTTP — a worker has one too. Before the fix, healthCheck was gated
    // on domain presence alone, so this spun until timeout fetching a URL
    // nothing ever answers, even though the platform already reported it ready.
    serveSequence([
      { status: "running", deployStatus: "idle", restartedAt: 2000, domain: "worker.example.test", containerPort: 0 },
    ]);

    const realFetch = globalThis.fetch;
    let fetchCalled = false;
    vi.stubGlobal("fetch", (url: string, opts?: any) => {
      if (typeof url === "string" && url.includes("worker.example.test")) fetchCalled = true;
      return realFetch(url, opts);
    });

    try {
      const result = await waitForAppReady("app1", 1000, { timeoutMs: 4000, healthCheck: true });
      expect(result.ok).toBe(true);
      expect(result.status).toBe("running");
      expect(fetchCalled).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("health check debounce: a single 200 mid-handover does not count as ready", async () => {
    serveSequence([{ status: "running", deployStatus: "idle", restartedAt: 2000, domain: "app.example.test" }]);

    const realFetch = globalThis.fetch;
    let call = 0;
    vi.stubGlobal("fetch", (url: string, opts?: any) => {
      if (typeof url === "string" && url.includes("app.example.test")) {
        call++;
        // First health check: healthy. Second (1.5s later, per the debounce):
        // 502 — the exact LIZARD-174 reproduction (old process still finishing
        // shutdown). Must not be reported as ready on the strength of check #1 alone.
        return Promise.resolve(new Response(null, { status: call === 1 ? 200 : 502 }));
      }
      return realFetch(url, opts);
    });

    try {
      const result = await waitForAppReady("app1", 1000, { timeoutMs: 4000, healthCheck: true });
      expect(result.ok).toBe(false);
      expect(result.status).toBe("timeout");
      expect(call).toBeGreaterThanOrEqual(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
