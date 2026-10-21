import { describe, it, expect } from "vitest";
import { parseType, relativeName } from "../../src/commands/domain-owned.js";

describe("lizard domain dns: names and types", () => {
  it("makes names relative to the domain", () => {
    expect(relativeName("@", "example.com")).toBe("@");
    expect(relativeName("example.com", "example.com")).toBe("@");
    expect(relativeName("api.example.com.", "example.com")).toBe("api");
    expect(relativeName("API", "example.com")).toBe("api");
    expect(relativeName("a.b", "example.com")).toBe("a.b");
  });
  it("accepts record types in any case, redirect as URL301", () => {
    expect(parseType("cname")).toBe("CNAME");
    expect(parseType("redirect")).toBe("URL301");
    expect(() => parseType("SRV")).toThrow(/Unknown record type/);
  });
});
