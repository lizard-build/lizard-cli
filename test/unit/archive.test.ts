import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createTarball } from "../../src/lib/archive.js";

describe("source upload archive", () => {
  it("preserves source bytes and unusual names through extraction", async () => {
    const root = mkdtempSync(join(tmpdir(), "lizard-archive-"));
    const names = ["normal.ts", "space name.ts", "line\nbreak.ts", "-flag.ts"];
    for (const name of names) writeFileSync(join(root, name), `source: ${name}`);
    const archive = await createTarball(names, root);
    const output = join(root, "output");
    mkdirSync(output);
    execFileSync("tar", ["-xzf", "-", "-C", output], { input: archive });
    for (const name of names) expect(readFileSync(join(output, name), "utf8")).toBe(`source: ${name}`);
  });

  it.skipIf(process.platform !== "darwin")("omits AppleDouble entries for files with macOS metadata", async () => {
    const root = mkdtempSync(join(tmpdir(), "lizard-archive-xattr-"));
    writeFileSync(join(root, "route.ts"), "export default 42;");
    execFileSync("xattr", ["-w", "com.lizard.docs-test", "metadata", join(root, "route.ts")]);
    const archive = await createTarball(["route.ts"], root);
    const listing = execFileSync("tar", ["-tzf", "-"], { input: archive, encoding: "utf8" });
    expect(listing.trim().split("\n")).toEqual(["route.ts"]);
  });
});
