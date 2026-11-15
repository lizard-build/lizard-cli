import { describe, expect, it } from "vitest";
import { generateKeyPairSync, sign } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RELEASE_PUBLIC_KEY, verifyReleaseSignature } from "../../src/lib/updater.js";

describe("self-update signatures", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pub = publicKey.export({ type: "spki", format: "pem" }).toString();
  const data = Buffer.from("a lizard binary");
  const sig = sign(null, data, privateKey).toString("base64");

  it("accepts the release key's signature", () => {
    expect(verifyReleaseSignature(data, sig + "\n", pub)).toBe(true);
  });

  it("refuses changed bytes, another key, and junk", () => {
    expect(verifyReleaseSignature(Buffer.from("a lizard binary!"), sig, pub)).toBe(false);
    expect(verifyReleaseSignature(data, sig)).toBe(false); // the built-in key did not sign this
    expect(verifyReleaseSignature(data, "", pub)).toBe(false);
    expect(verifyReleaseSignature(data, "not base64 at all", pub)).toBe(false);
    expect(verifyReleaseSignature(data, "<html>404</html>", pub)).toBe(false);
  });

  it("the built-in key is an Ed25519 public key", () => {
    expect(RELEASE_PUBLIC_KEY).toMatch(/^-----BEGIN PUBLIC KEY-----\n[A-Za-z0-9+/=]+\n-----END PUBLIC KEY-----\n$/);
  });

  it("scripts/sign-release.mjs refuses a key that is not the built-in one", () => {
    const dir = mkdtempSync(join(tmpdir(), "lz-sign-"));
    const f = join(dir, "lizard-linux-x64");
    writeFileSync(f, data);
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    expect(() => execFileSync(process.execPath, ["scripts/sign-release.mjs", f], { env: { ...process.env, LIZARD_RELEASE_SIGNING_KEY: pem }, stdio: "pipe" })).toThrow();
    expect(() => execFileSync(process.execPath, ["scripts/sign-release.mjs", f], { env: { ...process.env, LIZARD_RELEASE_SIGNING_KEY: "" }, stdio: "pipe" })).toThrow();
  });
});
