import { describe, test, expect } from "vitest";
import {
  withQuery,
  withScope,
  APIError,
  apiErrorFrom,
  isAuthError,
  isPlanRuleError,
  isProjectDeletedError,
} from "../../src/lib/api.js";

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
      branch: "main",
    });
    expect(url).toContain("workspaceId=ws_1");
    expect(url).toContain("branch=main");
    expect(url.startsWith("/api/projects?")).toBe(true);
  });

  test("skips null/undefined/empty values", () => {
    const url = withQuery("/api/projects", {
      workspaceId: "ws_1",
      missing: null,
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
    const url = withQuery("/api/projects", { branch: "feat/x" });
    expect(url).toBe("/api/projects?branch=feat%2Fx");
  });
});

describe("withScope", () => {
  test("returns path unchanged when scope is undefined", () => {
    expect(withScope("/api/projects/X/apps")).toBe("/api/projects/X/apps");
  });

  test("returns path unchanged when scope is empty", () => {
    expect(withScope("/api/projects/X/apps", {})).toBe("/api/projects/X/apps");
  });

  test("adds workspaceId", () => {
    expect(
      withScope("/api/projects/X/apps", { workspaceId: "ws_1" }),
    ).toBe("/api/projects/X/apps?workspaceId=ws_1");
  });

  test("treats null workspaceId as missing", () => {
    expect(
      withScope("/api/projects/X/apps", { workspaceId: null }),
    ).toBe("/api/projects/X/apps");
  });
});

describe("isProjectDeletedError", () => {
  const guardBody = {
    error: "Project is being deleted",
    message:
      "This project is in trash and cannot be modified. Restore it before making changes.",
  };

  test("matches the trashed-project write-guard 409", () => {
    expect(
      isProjectDeletedError(
        new APIError(409, "Project is being deleted", "", guardBody),
      ),
    ).toBe(true);
  });

  test("does not match a configRevision optimistic-concurrency 409", () => {
    const conflict = new APIError(409, "Config revision conflict", "", {
      error: "configRevision mismatch",
    });
    expect(isProjectDeletedError(conflict)).toBe(false);
  });

  test("does not match other statuses, even with the same body", () => {
    expect(
      isProjectDeletedError(new APIError(404, "x", "", guardBody)),
    ).toBe(false);
  });

  test("does not match non-APIError values", () => {
    expect(isProjectDeletedError(new Error("Project is being deleted"))).toBe(
      false,
    );
    expect(isProjectDeletedError(null)).toBe(false);
  });
});

describe("Pro trial sandbox refusals", () => {
  const billingUrl = "https://lizard.build/profile/account-billing";
  const sizeBody = {
    error: "The Pro trial includes Small sandboxes only. Large unlocks after the first Pro payment. Start Pro now in Billing, or run `lizard billing start-now`, to unlock it.",
    code: "TRIAL_SANDBOX_SIZE",
    size: "large",
    allowedSizes: ["small"],
    billingUrl,
  };

  test("print the Billing link under the message", () => {
    const err = apiErrorFrom(403, "Forbidden", sizeBody);
    expect(err.code).toBe("TRIAL_SANDBOX_SIZE");
    expect(err.message).toBe(`${sizeBody.error}\n  Billing: ${billingUrl}`);
  });

  test("print the message alone to a scoped key, which gets no link", () => {
    const { billingUrl: _, ...scoped } = sizeBody;
    expect(apiErrorFrom(403, "Forbidden", scoped).message).toBe(sizeBody.error);
  });

  test("are a plan rule, not an auth error, so they exit 1 rather than 2", () => {
    for (const code of ["TRIAL_SANDBOX_SIZE", "TRIAL_SANDBOX_REGION"]) {
      const err = apiErrorFrom(403, "Forbidden", { ...sizeBody, code });
      expect(isPlanRuleError(err)).toBe(true);
      expect(isAuthError(err)).toBe(false);
    }
  });

  test("leave every other 401 and 403 an auth error", () => {
    expect(isAuthError(apiErrorFrom(403, "Forbidden", { error: "Forbidden" }))).toBe(true);
    expect(isAuthError(apiErrorFrom(401, "Unauthorized", { error: "Unauthorized" }))).toBe(true);
    expect(isPlanRuleError(apiErrorFrom(403, "Forbidden", { error: "Forbidden" }))).toBe(false);
  });
});
