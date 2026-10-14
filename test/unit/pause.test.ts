import { describe, test, expect, vi, afterEach } from "vitest";
import { servicePausePath, printBulkResult } from "../../src/commands/pause.js";

afterEach(() => vi.restoreAllMocks());

describe("servicePausePath", () => {
  test("an app pauses and resumes through /api/apps/:id", () => {
    expect(servicePausePath("pause", { id: "a1", kind: "app" }, "p1", {})).toBe("/api/apps/a1/pause");
    expect(servicePausePath("resume", { id: "a1", kind: "app" }, "p1", { workspaceId: "w1" })).toBe("/api/apps/a1/resume?workspaceId=w1");
  });
  test("a database (addon) pauses through its project", () => {
    expect(servicePausePath("pause", { id: "d1", kind: "addon" }, "p1", { workspaceId: "w1" }))
      .toBe("/api/projects/p1/addons/d1/pause?workspaceId=w1");
  });
});

describe("printBulkResult", () => {
  test("lists what was paused and what was skipped with why", () => {
    const out: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: any) => { out.push(String(chunk)); return true; });
    printBulkResult("pause", "project demo", {
      done: [{ kind: "app", id: "a1", name: "web" }, { kind: "database", id: "d1", name: "postgres" }],
      skipped: [{ kind: "app", id: "a2", name: "worker", reason: "already paused" }],
    });
    const text = out.join("\n");
    expect(text).toContain("Paused 2 services in project demo");
    expect(text).toContain("web");
    expect(text).toContain("worker");
    expect(text).toContain("already paused");
  });
  test("says when there was nothing to do", () => {
    const out: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: any) => { out.push(String(chunk)); return true; });
    printBulkResult("resume", "workspace team", { done: [], skipped: [] });
    expect(out.join("\n")).toContain("nothing to resume");
  });
});
