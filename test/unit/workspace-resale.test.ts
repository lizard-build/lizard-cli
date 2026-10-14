import { describe, test, expect } from "vitest";
import { mergeResale } from "../../src/commands/workspace.js";

const ones = { cpu: 1, memory: 1, storage: 1, egress: 1, objectStorage: 1, sandbox: 1 };

describe("mergeResale", () => {
  test("no flag: show only", () => {
    expect(mergeResale(ones, {})).toBeNull();
  });
  test("changes only the flags given, keeps the rest", () => {
    expect(mergeResale({ ...ones, egress: 2 }, { cpu: "4", sandbox: "5" }))
      .toEqual({ ...ones, cpu: 4, egress: 2, sandbox: 5 });
  });
  test("--all sets every resource, a resource flag overrides it", () => {
    expect(mergeResale(ones, { all: "3", sandbox: "5" }))
      .toEqual({ cpu: 3, memory: 3, storage: 3, egress: 3, objectStorage: 3, sandbox: 5 });
  });
  test("rejects values outside 1-100 and non-numbers", () => {
    expect(() => mergeResale(ones, { cpu: "0.5" })).toThrow(/--cpu/);
    expect(() => mergeResale(ones, { objectStorage: "200" })).toThrow(/--object-storage/);
    expect(() => mergeResale(ones, { all: "x" })).toThrow(/--all/);
  });
});
