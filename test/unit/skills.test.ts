import { describe, expect, test } from "vitest";
import { EMBEDDED_SKILLS } from "../../src/lib/skills-data.generated.js";

const core = EMBEDDED_SKILLS.core.content;

/** GitHub-style heading slug, which the skill's own links use. */
const slug = (h: string) => h.toLowerCase().replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-");

describe("the core skill", () => {
  test("is the only embedded skill", () => {
    expect(Object.keys(EMBEDDED_SKILLS)).toEqual(["core"]);
  });

  test("covers sandboxes as well as deploys", () => {
    expect(core).toContain("\n## Sandboxes\n");
    for (const h of ["Quickstart", "Templates", "Running commands", "Files", "Ports", "Lifetime", "Snapshots and pause/resume", "From code: Lizard SDK"]) {
      expect(core).toContain(`\n### ${h}\n`);
    }
    for (const h of ["Deploying", "Secrets", "Managed addons", "Sign-in", "Exit codes", "Default project", "Billing"]) {
      expect(core).toContain(`\n## ${h}\n`);
    }
    expect(core).not.toContain("lizard skills get sandbox");
  });

  test("every #link points at a heading in the skill", () => {
    const headings = new Set([...core.matchAll(/^#{2,4} (.+)$/gm)].map((m) => slug(m[1])));
    const links = [...core.matchAll(/\]\(#([\w-]+)\)/g)].map((m) => m[1]);
    expect(links.filter((l) => !headings.has(l))).toEqual([]);
  });

  test("its description fits the 1024-character limit", () => {
    const description = core.match(/^description: "(.*)"$/m)![1];
    expect(description.length).toBeLessThanOrEqual(1024);
    expect(description).toMatch(/^Creates cloud sandboxes and deploys apps/);
  });
});
