import { describe, expect, test } from "vitest";
import { EMBEDDED_SKILLS } from "../../src/lib/skills-data.generated.js";

const core = EMBEDDED_SKILLS.core;
const files: Record<string, string> = {
  "SKILL.md": core.content,
  ...Object.fromEntries(Object.entries(core.references).map(([ref, md]) => [`references/${ref}.md`, md])),
};

/** GitHub-style heading slug, which the skill's own links use. */
const slug = (h: string) => h.toLowerCase().replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-");

describe("the core skill", () => {
  test("is the only embedded skill", () => {
    expect(Object.keys(EMBEDDED_SKILLS)).toEqual(["core"]);
  });

  test("ships the sandboxes, deploys and sdk references, and names each one", () => {
    expect(Object.keys(core.references).sort()).toEqual(["deploys", "sandboxes", "sdk"]);
    for (const ref of Object.keys(core.references)) {
      expect(core.content).toContain(`--ref ${ref}`);
    }
  });

  test("covers the whole platform in SKILL.md", () => {
    for (const h of ["Sign-in", "Exit codes", "Default project", "Sandboxes", "Deploys", "Databases and storage", "Secrets and config", "Domains", "Billing"]) {
      expect(core.content).toContain(`\n## ${h}\n`);
    }
    expect(core.content).not.toContain("lizard skills get sandbox ");
  });

  test("keeps SKILL.md under 500 lines", () => {
    const body = core.content.replace(/^---\n[\s\S]*?\n---\n/, "");
    expect(body.split("\n").length).toBeLessThan(500);
  });

  test.each(Object.keys(files))("every #link in %s points at a heading in the same file", (file) => {
    const md = files[file];
    const headings = new Set([...md.matchAll(/^#{1,4} (.+)$/gm)].map((m) => slug(m[1])));
    const links = [...md.matchAll(/\]\(#([\w-]+)\)/g)].map((m) => m[1]);
    expect(links.filter((l) => !headings.has(l))).toEqual([]);
  });

  test("references never link to other files", () => {
    for (const md of Object.values(core.references)) {
      expect(md).not.toMatch(/\]\((?!https?:|#)[^)]+\)/);
    }
  });

  test("its description fits the 1024-character limit", () => {
    const description = core.content.match(/^description: "(.*)"$/m)![1];
    expect(description.length).toBeLessThanOrEqual(1024);
    expect(description).toMatch(/^Creates cloud sandboxes and deploys apps/);
  });
});
