import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ── what `lizard up` must not upload by accident ────────────────────────────

const SECRET_DIRS = new Set([".ssh", ".aws", ".gnupg"]);
const SECRET_FILES = new Set([".npmrc", ".pypirc", ".netrc"]);
const ENV_TEMPLATES = new Set([".env.example", ".env.sample"]);

/** A `.env` or `.env.*` file that holds values (not `.env.example` / `.env.sample`). */
export function isEnvFile(name: string): boolean {
  return (name === ".env" || name.startsWith(".env.")) && !ENV_TEMPLATES.has(name);
}

/**
 * Credentials and keys that a folder walk would otherwise upload: env files, SSH/AWS/GnuPG
 * folders, package-manager and netrc credentials, Docker's login file, private keys.
 * `rel` is a /-separated path relative to the upload root.
 */
export function isSensitivePath(rel: string): boolean {
  const parts = rel.split("/");
  const name = parts[parts.length - 1];
  if (parts.slice(0, -1).some((d) => SECRET_DIRS.has(d))) return true;
  if (SECRET_DIRS.has(name)) return true;
  if (SECRET_FILES.has(name) || isEnvFile(name)) return true;
  if (name === "config.json" && parts[parts.length - 2] === ".docker") return true;
  if (/^id_(rsa|ed25519|ecdsa)/.test(name)) return true;
  const ext = path.extname(name).toLowerCase();
  return ext === ".pem" || ext === ".key";
}

/** The home folder or a file system root: a walk from there would upload a whole machine. */
export function isTooBroadToUpload(dir: string): boolean {
  const real = (p: string) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  const d = real(dir);
  return d === real(os.homedir()) || d === path.parse(d).root;
}

// ── .lizardignore (gitignore syntax) ────────────────────────────────────────

interface Rule {
  re: RegExp;
  negate: boolean;
  dirOnly: boolean;
}

function globToRegex(glob: string): string {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        const atStart = i === 0 || glob[i - 1] === "/";
        const atEnd = i + 2 === glob.length || glob[i + 2] === "/";
        if (atStart && atEnd) {
          if (glob[i + 2] === "/") {
            out += "(?:.*/)?"; // `**/`: any number of folders, including none
            i += 2;
          } else {
            out += ".*"; // trailing `**`: everything inside
            i += 1;
          }
          continue;
        }
      }
      out += "[^/]*";
    } else if (c === "?") {
      out += "[^/]";
    } else if (c === "[") {
      const close = glob.indexOf("]", i + 2);
      if (close === -1) {
        out += "\\[";
      } else {
        let body = glob.slice(i + 1, close).replace(/\\/g, "\\\\");
        if (body.startsWith("!")) body = "^" + body.slice(1);
        out += `[${body}]`;
        i = close;
      }
    } else if (c === "\\" && i + 1 < glob.length) {
      out += glob[++i].replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    } else {
      out += c.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    }
  }
  return out;
}

/** Parse gitignore-syntax text into a matcher for /-separated paths relative to its folder. */
export function parseIgnore(text: string): (rel: string, isDir?: boolean) => boolean {
  const rules: Rule[] = [];
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.replace(/(?<!\\)\s+$/, "");
    if (!line || line.startsWith("#")) continue;
    let negate = false;
    if (line.startsWith("!")) {
      negate = true;
      line = line.slice(1);
    } else if (line.startsWith("\\!") || line.startsWith("\\#")) {
      line = line.slice(1);
    }
    let dirOnly = false;
    if (line.endsWith("/")) {
      dirOnly = true;
      line = line.replace(/\/+$/, "");
    }
    if (!line) continue;
    const anchored = line.includes("/");
    line = line.replace(/^\//, "");
    const body = globToRegex(line);
    rules.push({ re: new RegExp(`^${anchored ? "" : "(?:.*/)?"}${body}$`), negate, dirOnly });
  }
  const verdict = (p: string, isDir: boolean): boolean | undefined => {
    let v: boolean | undefined;
    for (const r of rules) if ((!r.dirOnly || isDir) && r.re.test(p)) v = !r.negate;
    return v;
  };
  // As in git: a file inside an ignored folder stays ignored.
  return (rel: string, isDir = false) => {
    const parts = rel.split("/");
    for (let i = 1; i <= parts.length; i++) {
      if (verdict(parts.slice(0, i).join("/"), i < parts.length || isDir)) return true;
    }
    return false;
  };
}

/** The matcher for `<root>/.lizardignore`, or null when there is none. */
export function loadLizardIgnore(root: string): ((rel: string, isDir?: boolean) => boolean) | null {
  try {
    return parseIgnore(fs.readFileSync(path.join(root, ".lizardignore"), "utf8"));
  } catch {
    return null;
  }
}
