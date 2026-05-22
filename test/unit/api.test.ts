import { describe, test, expect } from "vitest";
import { withQuery, withScope } from "../../src/lib/api.js";

describe("withQuery", () => {
  test("returns path unchanged when no params", () => {
    expect(withQuery("/api/projects", {})).toBe("/api/projects");
  });

  test("appends a single param", () => {
    expect(withQuery("/api/projects", { workspaceId: "ws_1" })).toBe(
      "/api/projects?workspaceId=ws_1",
    );
  });

  test("appends multiple params", () => {
    const url = withQuery("/api/projects", {
      workspaceId: "ws_1",
      environment: "production",
    });
    expect(url).toContain("workspaceId=ws_1");
    expect(url).toContain("environment=production");
    expect(url.startsWith("/api/projects?")).toBe(true);
  });

  test("skips null/undefined/empty values", () => {
    const url = withQuery("/api/projects", {
      workspaceId: "ws_1",
      environment: null,
      branch: undefined,
      empty: "",
    });
    expect(url).toBe("/api/projects?workspaceId=ws_1");
  });

  test("uses & when path already has a query", () => {
    const url = withQuery("/api/projects?foo=bar", { workspaceId: "ws_1" });
    expect(url).toBe("/api/projects?foo=bar&workspaceId=ws_1");
  });

  test("URL-encodes special chars", () => {
    const url = withQuery("/api/projects", { environment: "feat/branch" });
    expect(url).toBe("/api/projects?environment=feat%2Fbranch");
  });
});

describe("withScope", () => {
  test("returns path unchanged when scope is undefined", () => {
    expect(withScope("/api/projects/X/apps")).toBe("/api/projects/X/apps");
  });

  test("returns path unchanged when scope is empty", () => {
    expect(withScope("/api/projects/X/apps", {})).toBe("/api/projects/X/apps");
  });

  test("adds workspaceId only", () => {
    expect(
      withScope("/api/projects/X/apps", { workspaceId: "ws_1" }),
    ).toBe("/api/projects/X/apps?workspaceId=ws_1");
  });

  test("adds environment only (mapped from environmentName)", () => {
    expect(
      withScope("/api/projects/X/apps", { environmentName: "staging" }),
    ).toBe("/api/projects/X/apps?environment=staging");
  });

  test("adds both workspaceId and environment", () => {
    const url = withScope("/api/projects/X/apps", {
      workspaceId: "ws_1",
      environmentName: "production",
    });
    expect(url).toContain("workspaceId=ws_1");
    expect(url).toContain("environment=production");
  });

  test("treats null scope values as missing", () => {
    expect(
      withScope("/api/projects/X/apps", {
        workspaceId: null,
        environmentName: null,
      }),
    ).toBe("/api/projects/X/apps");
  });
});
