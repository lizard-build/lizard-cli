import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fail, info, isJSONMode, printJSON, table } from "../lib/format.js";
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
        refs: (name) => {
            try {
                return readdirSync(path.join(dir, name, "references"))
                    .filter((f) => f.endsWith(".md"))
                    .map((f) => f.slice(0, -3))
                    .sort();
            }
            catch {
                return [];
            }
        },
        readRef: (name, ref) => {
            try {
                return readFileSync(path.join(dir, name, "references", `${ref}.md`), "utf8");
            }
            catch {
                return null;
            }
        },
        pathOf: (name, ref) => {
            if (!name)
                return dir;
            return ref
                ? path.join(dir, name, "references", `${ref}.md`)
                : path.join(dir, name, "SKILL.md");
        },
    };
}
function embeddedSource() {
    return {
        list: () => Object.keys(EMBEDDED_SKILLS).sort(),
        read: (name) => EMBEDDED_SKILLS[name]?.content ?? null,
        refs: (name) => Object.keys(EMBEDDED_SKILLS[name]?.references ?? {}).sort(),
        readRef: (name, ref) => EMBEDDED_SKILLS[name]?.references[ref] ?? null,
        pathOf: (name, ref) => {
            if (!name)
                return "embedded://skills";
            return ref
                ? `embedded://skills/${name}/references/${ref}.md`
                : `embedded://skills/${name}/SKILL.md`;
        },
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
function readRef(src, name, ref) {
    readSkill(src, name);
    const md = src.readRef(name, ref);
    if (md == null) {
        const refs = src.refs(name);
        throw new Error(`Reference '${ref}' not found in skill '${name}'. ` +
            (refs.length
                ? `Available: ${refs.join(", ")}.`
                : `This skill has no references.`));
    }
    return md;
}
function refEntries(src, name) {
    return src.refs(name).map((ref) => ({
        name: ref,
        path: src.pathOf(name, ref),
        command: `lizard skills get ${name} --ref ${ref}`,
    }));
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
                    let description = "";
                    try {
                        description = readSkill(src, n).meta.description || "";
                    }
                    catch {
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
            }
            catch {
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
        .action((name, opts) => {
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
        }
        catch (e) {
            fail(e.message, 3);
        }
    });
    skill
        .command("path")
        .description("Print the filesystem path of a skill (or the skills root)")
        .argument("[name]", "skill name; omit to print the skills directory")
        .option("--ref <ref>", "print the path of one reference instead")
        .action((name, opts) => {
        const src = getSource();
        const target = src.pathOf(name, name ? opts.ref : undefined);
        if (isJSONMode()) {
            printJSON({ path: target });
            return;
        }
        console.log(target);
    });
}
//# sourceMappingURL=skill.js.map