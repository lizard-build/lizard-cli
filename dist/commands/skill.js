import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { error, info, isJSONMode, printJSON, table } from "../lib/format.js";
const DEFAULT_SKILLS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "skill-data");
function skillsDir() {
    return process.env.LIZARD_SKILLS_DIR || DEFAULT_SKILLS_DIR;
}
function listSkills() {
    const dir = skillsDir();
    try {
        return readdirSync(dir)
            .filter((name) => {
            const p = path.join(dir, name);
            try {
                return statSync(p).isDirectory();
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
}
function skillFile(name) {
    return path.join(skillsDir(), name, "SKILL.md");
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
function readSkill(name) {
    const file = skillFile(name);
    let md;
    try {
        md = readFileSync(file, "utf8");
    }
    catch {
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
        .command("skill")
        .description("Read embedded agent skills shipped with this CLI version");
    skill
        .command("list")
        .description("List available skills with descriptions")
        .action(() => {
        const names = listSkills();
        if (isJSONMode()) {
            printJSON({
                dir: skillsDir(),
                skills: names.map((n) => {
                    try {
                        const { meta } = readSkill(n);
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
                const { meta } = readSkill(n);
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
        try {
            const { md, meta } = readSkill(name);
            if (isJSONMode()) {
                printJSON({
                    name,
                    path: skillFile(name),
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
        const target = name ? skillFile(name) : skillsDir();
        if (isJSONMode()) {
            printJSON({ path: target });
            return;
        }
        console.log(target);
    });
}
//# sourceMappingURL=skill.js.map