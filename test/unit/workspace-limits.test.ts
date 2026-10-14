import { describe, test, expect } from "vitest";
import { limitsBody, parseMemoryLimit } from "../../src/commands/workspace.js";

describe("limitsBody", () => {
  test("no flag: show only", () => {
    expect(limitsBody({})).toBeNull();
  });
  test("sends only the flags given; none removes a limit", () => {
    expect(limitsBody({ sandboxes: "5", cpu: "none" })).toEqual({ maxRunningSandboxes: 5, maxCpuVcpus: null });
    expect(limitsBody({ cpu: "1.5", memory: "4GB" })).toEqual({ maxCpuVcpus: 1.5, maxMemoryMb: 4096 });
  });
  test("rejects a fractional sandbox count and non-numbers", () => {
    expect(() => limitsBody({ sandboxes: "2.5" })).toThrow(/--sandboxes/);
    expect(() => limitsBody({ cpu: "lots" })).toThrow(/--cpu/);
  });
});

describe("parseMemoryLimit", () => {
  test("GB, MB, a bare number in MB, none", () => {
    expect(parseMemoryLimit("4GB")).toBe(4096);
    expect(parseMemoryLimit("1.5g")).toBe(1536);
    expect(parseMemoryLimit("512MB")).toBe(512);
    expect(parseMemoryLimit("2048")).toBe(2048);
    expect(parseMemoryLimit("none")).toBeNull();
    expect(() => parseMemoryLimit("4TB")).toThrow(/--memory/);
  });
});
