#!/usr/bin/env node
// Signs release assets for the CLI's self-update: writes <file>.sig (base64 Ed25519 signature
// of the file) for each file given, with the private key in LIZARD_RELEASE_SIGNING_KEY (PEM),
// then checks each one against the public key built into src/lib/updater.ts, so a release
// signed with the wrong key fails here instead of on every user's machine.
import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const pem = process.env.LIZARD_RELEASE_SIGNING_KEY;
if (!pem) {
  console.error("LIZARD_RELEASE_SIGNING_KEY is not set: release binaries must be signed");
  process.exit(1);
}
const key = createPrivateKey(pem);
const src = readFileSync(new URL("../src/lib/updater.ts", import.meta.url), "utf8");
const m = src.match(/RELEASE_PUBLIC_KEY = `([^`]+)`/);
if (!m) {
  console.error("RELEASE_PUBLIC_KEY not found in src/lib/updater.ts");
  process.exit(1);
}
const pub = createPublicKey(m[1]);
const files = process.argv.slice(2);
if (!files.length) {
  console.error("usage: sign-release.mjs <file>...");
  process.exit(1);
}
for (const f of files) {
  const data = readFileSync(f);
  const sig = sign(null, data, key);
  if (!verify(null, data, pub, sig)) {
    console.error(`${f}: signature does not verify with the key in updater.ts (wrong signing key?)`);
    process.exit(1);
  }
  writeFileSync(`${f}.sig`, sig.toString("base64") + "\n");
  console.log(`signed ${f}`);
}
