import { describe, expect, it } from "vitest";
import { describeMe } from "../../src/lib/signin.js";

describe("describeMe", () => {
  it("names an account by its username", () => {
    expect(describeMe({ id: "u1", username: "alice" })).toBe("alice");
  });

  it("names a project-scoped key by its project and workspace, never the owner", () => {
    const text = describeMe({
      // An older platform still sent the owner for a scoped key.
      id: "u1", username: "alice-the-owner", scoped: true,
      scopes: [{ type: "project", id: "p1", name: "Shop", workspaceId: "w1", workspaceName: "Acme" }],
    });
    expect(text).toBe("a key for project Shop (workspace Acme)");
    expect(text).not.toContain("alice");
  });

  it("names a workspace-scoped key by its workspace, falling back to the id", () => {
    expect(describeMe({ scoped: true, scopes: [{ type: "workspace", id: "w1", name: "Acme" }, { type: "workspace", id: "w2" }] }))
      .toBe("a key for workspace Acme, workspace w2");
  });
});
