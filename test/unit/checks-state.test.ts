import { describe, it, expect } from "vitest";
import { checksState } from "../../src/lib/lizard-git.js";

describe("checksState", () => {
  it("is success when every run passed and there are no commit statuses", () => {
    expect(checksState([], [{ status: "success" }])).toBe("success");
  });
  it("fails on a failed or cancelled run, or a failed status", () => {
    expect(checksState([], [{ status: "success" }, { status: "failure" }])).toBe("failure");
    expect(checksState([], [{ status: "cancelled" }])).toBe("failure");
    expect(checksState([{ state: "error" }], [{ status: "success" }])).toBe("failure");
  });
  it("is pending while anything is still going", () => {
    expect(checksState([{ state: "success" }], [{ status: "running" }])).toBe("pending");
    expect(checksState([{ state: "pending" }], [])).toBe("pending");
    expect(checksState([], [{ status: "waiting" }])).toBe("pending");
  });
  it("says none when there is nothing to check", () => {
    expect(checksState([], [])).toBe("none");
  });
});
