import { describe, test, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { CURRENT_VERSION } from "../../src/lib/updater.js";

const repoRoot = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const pkg = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"),
);

describe("version", () => {
  // `CURRENT_VERSION` is hardcoded in updater.ts (the Bun standalone binary has
  // no package.json at runtime to read it from). This keeps it from drifting
  // out of sync with package.json — bump both together.
  test("CURRENT_VERSION matches package.json", () => {
    expect(CURRENT_VERSION).toBe(pkg.version);
  });
});
