import { Command } from "commander";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fail, info, isJSONMode, printJSON, table } from "../lib/format.js";
import { EMBEDDED_SKILLS } from "../lib/skills-data.generated.js";

// Skills are embedded into the JS bundle at build time (see scripts/gen-skills.mjs).
// This makes `lizard skill` work both in the npm-installed package and in the
// Bun --compile standalone binary, where the skill-data/ directory is not
// reachable through the filesystem.
//
// LIZARD_SKILLS_DIR overrides the embedded source with a real directory — useful
// for authoring new skills locally without a rebuild.
//
// A skill is SKILL.md plus optional references/<ref>.md files that go deeper on
// one part of the platform; `lizard skills get <name> --ref <ref>` prints one.

interface Source {
  list(): string[];
  read(name: string): string | null;
  refs(name: string): string[];
  readRef(name: string, ref: string): string | null;
  pathOf(name?: string, ref?: string): string;
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
    refs: (name) => {
      try {
        return readdirSync(path.join(dir, name, "references"))
          .filter((f) => f.endsWith(".md"))
          .map((f) => f.slice(0, -3))
          .sort();
      } catch {
        return [];
      }
    },
    readRef: (name, ref) => {
      try {
        return readFileSync(path.join(dir, name, "references", `${ref}.md`), "utf8");
      } catch {
        return null;
      }
    },
    pathOf: (name, ref) => {
      if (!name) return dir;
      return ref
        ? path.join(dir, name, "references", `${ref}.md`)
        : path.join(dir, name, "SKILL.md");
    },
  };
}

function embeddedSource(): Source {
  return {
    list: () => Object.keys(EMBEDDED_SKILLS).sort(),
    read: (name) => EMBEDDED_SKILLS[name]?.content ?? null,
    refs: (name) => Object.keys(EMBEDDED_SKILLS[name]?.references ?? {}).sort(),
    readRef: (name, ref) => EMBEDDED_SKILLS[name]?.references[ref] ?? null,
    pathOf: (name, ref) => {
      if (!name) return "embedded://skills";
      return ref
        ? `embedded://skills/${name}/references/${ref}.md`
        : `embedded://skills/${name}/SKILL.md`;
    },
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

function readRef(src: Source, name: string, ref: string): string {
  readSkill(src, name);
  const md = src.readRef(name, ref);
  if (md == null) {
    const refs = src.refs(name);
    throw new Error(
      `Reference '${ref}' not found in skill '${name}'. ` +
        (refs.length
          ? `Available: ${refs.join(", ")}.`
          : `This skill has no references.`),
    );
  }
  return md;
}

function refEntries(src: Source, name: string) {
  return src.refs(name).map((ref) => ({
    name: ref,
    path: src.pathOf(name, ref),
    command: `lizard skills get ${name} --ref ${ref}`,
  }));
}

function shortDesc(desc: string, max = 100): string {
  const oneLine = desc.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max - 1) + "…" : oneLine;
}

export function registerSkill(program: Command) {
  const skill = program
    .command("skills")
    .alias("skill")
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
            let description = "";
            try {
              description = readSkill(src, n).meta.description || "";
            } catch {
              // unreadable SKILL.md: list it without a description
            }
            return { name: n, description, references: src.refs(n) };
          }),
        });
        return;
      }
      if (names.length === 0) {
        info("No skills found.");
        return;
      }
      const rows = names.map((n) => {
        let description = "";
        try {
          description = shortDesc(readSkill(src, n).meta.description || "");
        } catch {
          // unreadable SKILL.md: list it without a description
        }
        return [n, description, src.refs(n).join(", ")];
      });
      table(["name", "description", "references"], rows);
    });

  skill
    .command("get")
    .description("Print a skill's content (markdown), or one of its references")
    .argument("<name>", "skill name (e.g. core)")
    .option("--ref <ref>", "print one reference instead (e.g. sandboxes, deploys, sdk)")
    .option("--full", "append every reference after the skill")
    .action((name: string, opts: { ref?: string; full?: boolean }) => {
      const src = getSource();
      try {
        if (opts.ref) {
          const md = readRef(src, name, opts.ref);
          if (isJSONMode()) {
            printJSON({ name, ref: opts.ref, path: src.pathOf(name, opts.ref), content: md });
            return;
          }
          process.stdout.write(md.endsWith("\n") ? md : md + "\n");
          return;
        }
        const { md, meta } = readSkill(src, name);
        let content = md;
        if (opts.full) {
          for (const ref of src.refs(name)) {
            const body = src.readRef(name, ref) ?? "";
            content = `${content.trimEnd()}\n\n---\n<!-- references/${ref}.md -->\n\n${body}`;
          }
        }
        if (isJSONMode()) {
          printJSON({
            name,
            path: src.pathOf(name),
            frontmatter: meta,
            content,
            references: refEntries(src, name),
          });
          return;
        }
        process.stdout.write(content.endsWith("\n") ? content : content + "\n");
      } catch (e: any) {
        fail(e.message, 3);
      }
    });

  skill
    .command("path")
    .description("Print the filesystem path of a skill (or the skills root)")
    .argument("[name]", "skill name; omit to print the skills directory")
    .option("--ref <ref>", "print the path of one reference instead")
    .action((name: string | undefined, opts: { ref?: string }) => {
      const src = getSource();
      const target = src.pathOf(name, name ? opts.ref : undefined);
      if (isJSONMode()) {
        printJSON({ path: target });
        return;
      }
      console.log(target);
    });
}
