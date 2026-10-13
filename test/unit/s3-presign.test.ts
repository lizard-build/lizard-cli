import { describe, expect, test } from "vitest";
import { presignGet } from "../../src/commands/s3.js";

describe("lizard s3 url", () => {
  const base = {
    endpoint: "https://s3-us-east-1.onlizard.com/addon123",
    accessKeyId: "AKIDEXAMPLE",
    secretKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
    region: "us-east-1",
    bucket: "default",
    expiresIn: 3600,
    now: new Date("2026-10-13T10:00:00.000Z"),
  };

  test("signs a path-style GET under the addon's endpoint path", () => {
    const url = new URL(presignGet({ ...base, key: "reports/q3 report.txt" }));
    expect(url.host).toBe("s3-us-east-1.onlizard.com");
    expect(url.pathname).toBe("/addon123/default/reports/q3%20report.txt");
    expect(url.searchParams.get("X-Amz-Credential")).toBe("AKIDEXAMPLE/20261013/us-east-1/s3/aws4_request");
    expect(url.searchParams.get("X-Amz-Date")).toBe("20261013T100000Z");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("3600");
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
  });

  test("the signature changes with the key and the expiry, and is stable otherwise", () => {
    const a = presignGet({ ...base, key: "a.txt" });
    expect(presignGet({ ...base, key: "a.txt" })).toBe(a);
    expect(presignGet({ ...base, key: "b.txt" })).not.toBe(a);
    expect(presignGet({ ...base, key: "a.txt", expiresIn: 60 })).not.toBe(a);
  });
});
