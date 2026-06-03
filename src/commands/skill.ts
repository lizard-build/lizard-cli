import { Command } from "commander";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { error, info, isJSONMode, printJSON, table } from "../lib/format.js";
import { EMBEDDED_SKILLS } from "../lib/skills-data.generated.js";

// Skills are embedded into the JS bundle at build time (see scripts/gen-skills.mjs).
// This makes `lizard skill` work both in the npm-installed package and in the
// Bun --compile standalone binary, where the skill-data/ directory is not
// reachable through the filesystem.
//
// LIZARD_SKILLS_DIR overrides the embedded source with a real directory — useful
// for authoring new skills locally without a rebuild.

interface Source {
  list(): string[];
  read(name: string): string | null;
  pathOf(name?: string): string;
}

function fsSource(dir: string): Source {
  return {
    list: () => {
      try {
        return readdirSync(dir)
          .filter((name) => {
            try {
              return statSync(path.join(dir, name)).isDirectory();
            } catch {
              return false;
            }
          })
          .sort();
      } catch {
        return [];
      }
    },
    read: (name) => {
      try {
        return readFileSync(path.join(dir, name, "SKILL.md"), "utf8");
      } catch {
        return null;
      }
    },
    pathOf: (name) => (name ? path.join(dir, name, "SKILL.md") : dir),
  };
}

function embeddedSource(): Source {
  return {
    list: () => Object.keys(EMBEDDED_SKILLS).sort(),
    read: (name) => EMBEDDED_SKILLS[name]?.content ?? null,
    pathOf: (name) =>
      name ? `embedded://skills/${name}/SKILL.md` : "embedded://skills",
  };
}

function getSource(): Source {
  const override = process.env.LIZARD_SKILLS_DIR;
  return override ? fsSource(override) : embeddedSource();
}

// Minimal YAML-ish frontmatter parser. Pulls top-level scalar keys (name,
// description, etc.) — enough to render `lizard skill list`. Full YAML parsing
// would add a dependency for no real win.
function parseFrontmatter(md: string): Record<string, string> {
  if (!md.startsWith("---")) return {};
  const end = md.indexOf("\n---", 3);
  if (end === -1) return {};
  const body = md.slice(3, end).replace(/^\r?\n/, "");
  const out: Record<string, string> = {};
  for (const raw of body.split(/\r?\n/)) {
    const m = raw.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!m) continue;
    let val = m[2].trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[m[1]] = val;
  }
  return out;
}

function readSkill(
  src: Source,
  name: string,
): { md: string; meta: Record<string, string> } {
  const md = src.read(name);
  if (md == null) {
    throw new Error(
      `Skill '${name}' not found. Run \`lizard skill list\` to see available skills.`,
    );
  }
  return { md, meta: parseFrontmatter(md) };
}

function shortDesc(desc: string, max = 100): string {
  const oneLine = desc.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max - 1) + "…" : oneLine;
}

export function registerSkill(program: Command) {
  const skill = program
    .command("skill")
    .description("Read embedded agent skills shipped with this CLI version");

  skill
    .command("list")
    .description("List available skills with descriptions")
    .action(() => {
      const src = getSource();
      const names = src.list();
      if (isJSONMode()) {
        printJSON({
          dir: src.pathOf(),
          skills: names.map((n) => {
            try {
              const { meta } = readSkill(src, n);
              return { name: n, description: meta.description || "" };
            } catch {
              return { name: n, description: "" };
            }
          }),
        });
        return;
      }
      if (names.length === 0) {
        info("No skills found.");
        return;
      }
      const rows = names.map((n) => {
        try {
          const { meta } = readSkill(src, n);
          return [n, shortDesc(meta.description || "")];
        } catch {
          return [n, ""];
        }
      });
      table(["name", "description"], rows);
    });

  skill
    .command("get")
    .description("Print a skill's full content (markdown)")
    .argument("<name>", "skill name (e.g. core)")
    .option(
      "--full",
      "Include reference files (reserved; currently equivalent to default)",
    )
    .action((name: string, _opts: { full?: boolean }) => {
      const src = getSource();
      try {
        const { md, meta } = readSkill(src, name);
        if (isJSONMode()) {
          printJSON({
            name,
            path: src.pathOf(name),
            frontmatter: meta,
            content: md,
          });
          return;
        }
        process.stdout.write(md.endsWith("\n") ? md : md + "\n");
      } catch (e: any) {
        error(e.message);
        process.exit(3);
      }
    });

  skill
    .command("path")
    .description("Print the filesystem path of a skill (or the skills root)")
    .argument("[name]", "skill name; omit to print the skills directory")
    .action((name?: string) => {
      const src = getSource();
      const target = src.pathOf(name);
      if (isJSONMode()) {
        printJSON({ path: target });
        return;
      }
      console.log(target);
    });
}
