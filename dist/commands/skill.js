import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { error, info, isJSONMode, printJSON, table } from "../lib/format.js";
import { EMBEDDED_SKILLS } from "../lib/skills-data.generated.js";
function fsSource(dir) {
    return {
        list: () => {
            try {
                return readdirSync(dir)
                    .filter((name) => {
                    try {
                        return statSync(path.join(dir, name)).isDirectory();
                    }
                    catch {
                        return false;
                    }
                })
                    .sort();
            }
            catch {
                return [];
            }
        },
        read: (name) => {
            try {
                return readFileSync(path.join(dir, name, "SKILL.md"), "utf8");
            }
            catch {
                return null;
            }
        },
        pathOf: (name) => (name ? path.join(dir, name, "SKILL.md") : dir),
    };
}
function embeddedSource() {
    return {
        list: () => Object.keys(EMBEDDED_SKILLS).sort(),
        read: (name) => EMBEDDED_SKILLS[name]?.content ?? null,
        pathOf: (name) => name ? `embedded://skills/${name}/SKILL.md` : "embedded://skills",
    };
}
function getSource() {
    const override = process.env.LIZARD_SKILLS_DIR;
    return override ? fsSource(override) : embeddedSource();
}
// Minimal YAML-ish frontmatter parser. Pulls top-level scalar keys (name,
// description, etc.) — enough to render `lizard skill list`. Full YAML parsing
// would add a dependency for no real win.
function parseFrontmatter(md) {
    if (!md.startsWith("---"))
        return {};
    const end = md.indexOf("\n---", 3);
    if (end === -1)
        return {};
    const body = md.slice(3, end).replace(/^\r?\n/, "");
    const out = {};
    for (const raw of body.split(/\r?\n/)) {
        const m = raw.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
        if (!m)
            continue;
        let val = m[2].trim();
        if ((val.startsWith('"') && val.endsWith('"')) ||
            (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
        }
        out[m[1]] = val;
    }
    return out;
}
function readSkill(src, name) {
    const md = src.read(name);
    if (md == null) {
        throw new Error(`Skill '${name}' not found. Run \`lizard skill list\` to see available skills.`);
    }
    return { md, meta: parseFrontmatter(md) };
}
function shortDesc(desc, max = 100) {
    const oneLine = desc.replace(/\s+/g, " ").trim();
    return oneLine.length > max ? oneLine.slice(0, max - 1) + "…" : oneLine;
}
export function registerSkill(program) {
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
                    try {
                        const { meta } = readSkill(src, n);
                        return { name: n, description: meta.description || "" };
                    }
                    catch {
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
            }
            catch {
                return [n, ""];
            }
        });
        table(["name", "description"], rows);
    });
    skill
        .command("get")
        .description("Print a skill's full content (markdown)")
        .argument("<name>", "skill name (e.g. core)")
        .option("--full", "Include reference files (reserved; currently equivalent to default)")
        .action((name, _opts) => {
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
        }
        catch (e) {
            error(e.message);
            process.exit(3);
        }
    });
    skill
        .command("path")
        .description("Print the filesystem path of a skill (or the skills root)")
        .argument("[name]", "skill name; omit to print the skills directory")
        .action((name) => {
        const src = getSource();
        const target = src.pathOf(name);
        if (isJSONMode()) {
            printJSON({ path: target });
            return;
        }
        console.log(target);
    });
}
//# sourceMappingURL=skill.js.map