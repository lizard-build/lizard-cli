import { describe, expect, test, afterEach } from "vitest";
import * as path from "node:path";
import { EMBEDDED_SKILLS } from "../../src/lib/skills-data.generated.js";
import { expandIncludes } from "../../src/commands/skill.js";
import { skillFor } from "../../src/lib/skill-route.js";
import * as fs from "node:fs";

const SKILL_DATA = path.resolve(import.meta.dirname, "../../skill-data");

function frontmatter(md: string): Record<string, string> {
  const block = md.slice(4, md.indexOf("\n---", 3));
  return Object.fromEntries(
    block.split("\n").map((l) => l.match(/^([\w-]+):\s*"?(.*?)"?$/)).filter(Boolean).map((m) => [m![1], m![2]]),
  );
}

/** GitHub-style heading slug, which the skills' own links use. */
const slug = (h: string) => h.toLowerCase().replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-");

describe("embedded skills", () => {
  test("ship core and sandbox, and not the shared parts as a skill", () => {
    expect(Object.keys(EMBEDDED_SKILLS).sort()).toEqual(["core", "sandbox"]);
  });

  test.each(["core", "sandbox"])("%s has the shared basics inlined", (name) => {
    const md = EMBEDDED_SKILLS[name].content;
    expect(md).not.toContain("<!-- include");
    for (const h of ["## Execution rules", "## Discovery", "## Sign-in", "## Exit codes", "## Default project", "## Billing"]) {
      expect(md).toContain(`\n${h}\n`);
    }
  });

  test.each(["core", "sandbox"])("%s: every #link points at a heading in the same skill", (name) => {
    const md = EMBEDDED_SKILLS[name].content;
    const headings = new Set([...md.matchAll(/^#{2,3} (.+)$/gm)].map((m) => slug(m[1])));
    const links = [...md.matchAll(/\]\(#([\w-]+)\)/g)].map((m) => m[1]);
    expect(links.filter((l) => !headings.has(l))).toEqual([]);
  });

  test("descriptions fit the 1024-character limit and say who they are for", () => {
    const core = frontmatter(EMBEDDED_SKILLS.core.content);
    const sandbox = frontmatter(EMBEDDED_SKILLS.sandbox.content);
    expect(sandbox.name).toBe("lizard-sandbox");
    expect(core.description.length).toBeLessThanOrEqual(1024);
    expect(sandbox.description.length).toBeLessThanOrEqual(1024);
    expect(sandbox.description).toMatch(/^Creates and manages Lizard sandboxes/);
  });

  test("sandbox work lives only in the sandbox skill, and core points there", () => {
    const core = EMBEDDED_SKILLS.core.content;
    const sandbox = EMBEDDED_SKILLS.sandbox.content;
    expect(core).not.toMatch(/^## Sandboxes/m);
    expect(core).toContain("lizard skills get sandbox --json");
    for (const h of ["## Quickstart", "## Templates", "## Lifetime", "## Snapshots and pause/resume", "## From code: Lizard SDK"]) {
      expect(sandbox).toContain(`\n${h}\n`);
    }
    expect(sandbox).toContain("lizard skills get core --json");
  });
});

describe("skill routing in --help", () => {
  test("sandbox, volume and agents point at the sandbox skill, the rest at core", () => {
    expect(["sandbox", "volume", "agents"].map(skillFor)).toEqual(["sandbox", "sandbox", "sandbox"]);
    expect(["up", "logs", "secrets", "add"].map(skillFor)).toEqual(["core", "core", "core", "core"]);
  });
});

describe("LIZARD_SKILLS_DIR (authoring from files)", () => {
  test("includes expand the same way as the embedded copy", () => {
    const raw = fs.readFileSync(path.join(SKILL_DATA, "sandbox", "SKILL.md"), "utf8");
    expect(expandIncludes(raw, SKILL_DATA)).toBe(EMBEDDED_SKILLS.sandbox.content);
  });

  test("an include outside the skills folder is left as it is", () => {
    const line = "<!-- include: ../package.json -->";
    expect(expandIncludes(line, SKILL_DATA)).toBe(line);
  });
});
