import { describe, it, expect } from "vitest";
import { parseType, recordsToReplace, relativeName } from "../../src/commands/domain-owned.js";

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

describe("lizard domain <bought domain>: records it would replace", () => {
  const rec = (name: string, type: string, value: string) => ({ name, type, value, ttl: 1800 }) as never;
  it("lists pointing records on the names being connected, and nothing else", () => {
    const records = [
      rec("@", "A", "203.0.113.10"), rec("@", "MX", "mail.example.com"), rec("@", "TXT", "v=spf1"),
      rec("api", "CNAME", "elsewhere.example.net"), rec("www", "CNAME", "other.example.net"),
    ];
    expect(recordsToReplace(records, ["@", "www"]).map((r: { name: string }) => r.name)).toEqual(["@", "www"]);
    expect(recordsToReplace(records, ["api"])).toHaveLength(1);
    expect(recordsToReplace(records, ["blog"])).toHaveLength(0);
  });
  it("does not count the parking page or an earlier Lizard target", () => {
    const records = [rec("www", "CNAME", "parkingpage.namecheap.com."), rec("@", "ALIAS", "eu.onlizard.com")];
    expect(recordsToReplace(records, ["@", "www"])).toHaveLength(0);
  });
});
