import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { APIError } from "./api.js";
import { gitURL, lg, repoPath, sendRaw } from "./lizard-git.js";
/**
 * A Lizard Git working copy (after Scion: lizard.build/git keeps no repositories as files and
 * makes every commit on the server).
 *
 * A checkout is files plus .lizard-git/checkout.json (named like .git: a repository's own
 * .lizard/ folder holds its CI workflows): which repository and branch, the changeset
 * the files came from (base), and each file's hash. Nothing else is local: no history, no
 * object database. Contents come from the server by hash, through a cache shared by every
 * checkout on this machine (~/.cache/lizard/git; immutable, so it never needs invalidating),
 * and a sparse checkout only ever fetches the folders it covers.
 *
 * `commit` sends what changed: the server is asked which contents it lacks, those are
 * uploaded, then one request makes the commit on the branch. If the branch moved since base,
 * the server places the change on the new tip (merging the same files line by line); only a
 * real conflict comes back.
 */
export const STATE_DIR = ".lizard-git";
const STATE_FILE = "checkout.json";
// ── state ──────────────────────────────────────────────────────────────
/** The checkout containing dir (walking up), or null. */
export function findCheckout(dir = process.cwd()) {
    for (let d = dir;; d = dirname(d)) {
        if (existsSync(join(d, STATE_DIR, STATE_FILE)))
            return d;
        if (dirname(d) === d)
            return null;
    }
}
export function loadCheckout(root) {
    const c = JSON.parse(readFileSync(join(root, STATE_DIR, STATE_FILE), "utf8"));
    if (c.version !== 1 || !c.repo || !c.branch)
        throw new APIError(400, `${root}: not a Lizard Git checkout`);
    return c;
}
export function saveCheckout(root, c) {
    mkdirSync(join(root, STATE_DIR), { recursive: true });
    const p = join(root, STATE_DIR, STATE_FILE);
    writeFileSync(p + ".tmp", JSON.stringify(c));
    renameSync(p + ".tmp", p);
}
export const sha256 = (b) => createHash("sha256").update(b).digest("hex");
// ── objects, through the machine cache ──────────────────────────────────
function cacheDir() {
    return process.env.LIZARD_GIT_CACHE || join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "lizard", "git");
}
function cachePath(kind, h) {
    return join(cacheDir(), kind, h.slice(0, 2), h);
}
function cacheGet(kind, h) {
    try {
        const b = readFileSync(cachePath(kind, h));
        if (kind === "b" && sha256(b) !== h)
            return null; // damaged: fetch again
        return b;
    }
    catch {
        return null;
    }
}
function cachePut(kind, h, b) {
    try {
        const p = cachePath(kind, h);
        mkdirSync(dirname(p), { recursive: true });
        const tmp = `${p}.${process.pid}.tmp`;
        writeFileSync(tmp, b);
        renameSync(tmp, p);
    }
    catch {
        // the cache is an optimisation; a read-only home just means no cache
    }
}
const CHUNK = 2000;
/** Trees by hash (cached forever: a tree never changes). */
export async function getTrees(repo, hashes) {
    const out = new Map();
    const need = [];
    for (const h of new Set(hashes)) {
        const c = cacheGet("t", h);
        if (c)
            out.set(h, JSON.parse(c.toString()));
        else
            need.push(h);
    }
    for (let i = 0; i < need.length; i += CHUNK) {
        const r = await lg.post(`${repoPath(repo)}/objects`, { trees: need.slice(i, i + CHUNK), blobs: [] });
        for (const [h, entries] of Object.entries(r.trees)) {
            out.set(h, entries);
            cachePut("t", h, Buffer.from(JSON.stringify(entries)));
        }
    }
    for (const h of need)
        if (!out.has(h))
            throw new APIError(404, `tree ${h.slice(0, 12)} is not in ${repo}`);
    return out;
}
/** File contents by hash: small ones batched, big ones one by one, all cached. */
export async function getBlobs(repo, hashes, onProgress) {
    const out = new Map();
    const need = [];
    for (const h of new Set(hashes)) {
        const c = cacheGet("b", h);
        if (c)
            out.set(h, c);
        else
            need.push(h);
    }
    const single = [];
    for (let i = 0; i < need.length; i += 500) {
        const r = await lg.post(`${repoPath(repo)}/objects`, { trees: [], blobs: need.slice(i, i + 500) });
        for (const [h, b64] of Object.entries(r.blobs)) {
            const b = Buffer.from(b64, "base64");
            if (sha256(b) !== h)
                throw new APIError(502, `content ${h.slice(0, 12)} does not match its hash`);
            out.set(h, b);
            cachePut("b", h, b);
        }
        single.push(...(r.fetchSeparately ?? []));
        onProgress?.(out.size);
    }
    // Big files: a few at a time.
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(6, single.length) }, async () => {
        while (next < single.length) {
            const h = single[next++];
            const b = Buffer.from(await (await sendRaw("GET", `${repoPath(repo)}/objects/${h}`)).arrayBuffer());
            if (sha256(b) !== h)
                throw new APIError(502, `content ${h.slice(0, 12)} does not match its hash`);
            out.set(h, b);
            cachePut("b", h, b);
            onProgress?.(out.size);
        }
    }));
    for (const h of need)
        if (!out.has(h))
            throw new APIError(404, `content ${h.slice(0, 12)} is not in ${repo}`);
    return out;
}
// ── trees → file lists ─────────────────────────────────────────────────
/** Is path inside the sparse set (or a folder on the way to one)? */
function inSparse(p, sparse, orAncestor = false) {
    if (!sparse)
        return true;
    return sparse.some((s) => p === s || p.startsWith(s + "/") || (orAncestor && s.startsWith(p + "/")));
}
/**
 * Every file under root (within sparse), walked one level per request: the client never says
 * what it has, it asks for the trees it walks into (Scion's negotiation).
 */
export async function listFiles(repo, root, sparse) {
    const files = new Map();
    let level = [{ hash: root, prefix: "" }];
    while (level.length) {
        const trees = await getTrees(repo, level.map((l) => l.hash));
        const next = [];
        for (const { hash, prefix } of level) {
            for (const e of trees.get(hash)) {
                const p = prefix + e.name;
                if (e.type === "tree") {
                    if (inSparse(p, sparse, true))
                        next.push({ hash: e.hash, prefix: p + "/" });
                }
                else if (e.type === "blob" && inSparse(p, sparse)) {
                    files.set(p, { h: e.hash, m: e.mode, size: e.size });
                }
            }
        }
        level = next;
    }
    return files;
}
// ── working files ──────────────────────────────────────────────────────
function safeJoin(root, p) {
    if (p.split("/").some((x) => x === "" || x === "." || x === ".." || x === STATE_DIR) || p.includes("\\") || p.includes("\0")) {
        throw new APIError(400, `refusing a path outside the checkout: ${p}`);
    }
    return join(root, ...p.split("/"));
}
function writeFile(root, p, content, mode) {
    const full = safeJoin(root, p);
    mkdirSync(dirname(full), { recursive: true });
    try {
        const st = lstatSync(full);
        if (st.isDirectory())
            rmSync(full, { recursive: true });
        else
            unlinkSync(full);
    }
    catch { }
    if (mode === "120000") {
        symlinkSync(content.toString(), full);
    }
    else {
        writeFileSync(full, content);
        chmodSync(full, mode === "100755" ? 0o755 : 0o644);
    }
    const st = lstatSync(full);
    return { h: sha256(content), m: mode, s: st.size, t: Math.floor(st.mtimeMs) };
}
export function removeFileAt(root, p) {
    removeFile(root, p);
}
function removeFile(root, p) {
    const full = safeJoin(root, p);
    try {
        unlinkSync(full);
    }
    catch { }
    // Empty folders go too (as on the server).
    for (let d = dirname(full); d !== root && d.startsWith(root + sep); d = dirname(d)) {
        try {
            if (readdirSync(d).length)
                break;
            rmSync(d, { recursive: true });
        }
        catch {
            break;
        }
    }
}
/** Ignore rules: .lizard/, .git/, node_modules/ and the simple patterns of .gitignore files. */
function ignorer(root) {
    const rules = [];
    const add = (pat, base) => {
        let neg = false;
        if (pat.startsWith("!")) {
            neg = true;
            pat = pat.slice(1);
        }
        const dirOnly = pat.endsWith("/");
        pat = pat.replace(/\/+$/, "");
        if (!pat)
            return;
        const anchored = pat.includes("/");
        const esc = pat.replace(/^\//, "").replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\0").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]").replace(/\0/g, ".*");
        const prefix = base ? base.replace(/[.+^${}()|[\]\\]/g, "\\$&") + "/" : "";
        rules.push({ re: new RegExp(anchored ? `^${prefix}${esc}$` : `^${prefix}(?:.*/)?${esc}$`), dirOnly, neg });
    };
    const load = (dir, base) => {
        try {
            for (const line of readFileSync(join(dir, ".gitignore"), "utf8").split("\n")) {
                const l = line.trim();
                if (l && !l.startsWith("#"))
                    add(l, base);
            }
        }
        catch { }
    };
    load(root, "");
    const loaded = new Set([""]);
    return (rel, isDir) => {
        const name = rel.split("/").pop();
        if (name === STATE_DIR || name === ".git")
            return true;
        if (isDir && name === "node_modules")
            return true;
        const parent = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
        if (!loaded.has(parent)) {
            loaded.add(parent);
            load(join(root, ...parent.split("/")), parent);
        }
        let ignored = false;
        for (const r of rules)
            if ((!r.dirOnly || isDir) && r.re.test(rel))
                ignored = !r.neg;
        return ignored;
    };
}
/** The working files within the sparse set, hashed (unchanged ones skipped by size and mtime). */
export function scanWorking(root, c) {
    const ignore = ignorer(root);
    const out = new Map();
    const walk = (dir) => {
        for (const ent of readdirSync(dir, { withFileTypes: true })) {
            const full = join(dir, ent.name);
            const rel = relative(root, full).split(sep).join("/");
            if (ent.isDirectory()) {
                if (!ignore(rel, true) && inSparse(rel, c.sparse, true))
                    walk(full);
                continue;
            }
            if (ignore(rel, false) || !inSparse(rel, c.sparse))
                continue;
            const st = lstatSync(full);
            let mode;
            if (st.isSymbolicLink())
                mode = "120000";
            else if (st.isFile())
                mode = st.mode & 0o111 ? "100755" : "100644";
            else
                continue;
            const known = c.files[rel];
            const t = Math.floor(st.mtimeMs);
            if (known && known.s === st.size && known.t === t && known.m === mode) {
                out.set(rel, { h: known.h, m: mode, s: st.size, t });
                continue;
            }
            const content = mode === "120000" ? Buffer.from(readlinkSync(full)) : readFileSync(full);
            out.set(rel, { h: sha256(content), m: mode, s: st.size, t });
        }
    };
    walk(root);
    return out;
}
export function changesOf(c, local) {
    const ch = { added: [], modified: [], deleted: [] };
    for (const [p, f] of local) {
        const known = c.files[p];
        if (!known)
            ch.added.push(p);
        else if (known.h !== f.h || known.m !== f.m)
            ch.modified.push(p);
    }
    for (const p of Object.keys(c.files))
        if (!local.has(p))
            ch.deleted.push(p);
    for (const l of [ch.added, ch.modified, ch.deleted])
        l.sort();
    return ch;
}
// ── operations ─────────────────────────────────────────────────────────
/** Make an existing folder the checkout of an empty repository: its files become the first commit. */
export async function initHere(repo, dir) {
    if (findCheckout(dir))
        throw new APIError(400, `${dir} is in a checkout already`);
    const info = await lg.get(repoPath(repo));
    if (!info.empty)
        throw new APIError(409, `${repo} has commits already: check it out with lizard git clone ${repo}`);
    const c = { version: 1, url: gitURL(), repo, branch: info.repo.defaultBranch, base: "", root: "", sparse: null, files: {} };
    saveCheckout(dir, c);
    return c;
}
/** Point a fresh checkout at a branch's tip and write its files. */
export async function clone(repo, dir, branch, sparse, onProgress) {
    if (existsSync(dir) && readdirSync(dir).length)
        throw new APIError(400, `${dir} exists and is not empty`);
    const info = await lg.get(repoPath(repo));
    mkdirSync(dir, { recursive: true });
    if (info.empty) {
        // Nothing to fetch: the first commit from here creates the branch.
        const c = { version: 1, url: gitURL(), repo, branch: branch ?? info.repo.defaultBranch, base: "", root: "", sparse, files: {} };
        saveCheckout(dir, c);
        return c;
    }
    const r = await lg.get(`${repoPath(repo)}/resolve${branch ? `?rev=${encodeURIComponent(branch)}` : ""}`);
    const c = { version: 1, url: gitURL(), repo, branch: branch ?? info.repo.defaultBranch, base: r.id, root: r.root, sparse, files: {} };
    onProgress?.("listing files");
    const files = await listFiles(repo, r.root, sparse);
    onProgress?.(`fetching ${files.size} files`);
    const blobs = await getBlobs(repo, [...files.values()].map((f) => f.h), (n) => onProgress?.(`fetched ${n}/${files.size}`));
    for (const [p, f] of files)
        c.files[p] = writeFile(dir, p, blobs.get(f.h), f.m);
    saveCheckout(dir, c);
    return c;
}
/**
 * Bring the files to the branch's tip (or another branch: switching). Local changes are kept;
 * if the tip changed the same files, nothing is touched and the conflict comes back: commit
 * first, and the server merges.
 */
export async function sync(root, c, toBranch) {
    const branch = toBranch ?? c.branch;
    const r = await lg.get(`${repoPath(c.repo)}/resolve?rev=${encodeURIComponent(branch)}`);
    const res = { from: c.base, to: r.id, updated: [], removed: [] };
    if (r.id === c.base && branch === c.branch)
        return res;
    const want = await listFiles(c.repo, r.root, c.sparse);
    const local = scanWorking(root, c);
    const mine = changesOf(c, local);
    const dirty = new Set([...mine.added, ...mine.modified, ...mine.deleted]);
    const toWrite = [];
    const toRemove = [];
    for (const [p, f] of want) {
        const k = c.files[p];
        if (!k || k.h !== f.h || k.m !== f.m)
            toWrite.push([p, f]);
    }
    for (const p of Object.keys(c.files))
        if (!want.has(p))
            toRemove.push(p);
    const clash = [...toWrite.map(([p]) => p), ...toRemove].filter((p) => {
        if (!dirty.has(p))
            return false;
        const l = local.get(p);
        const w = want.get(p);
        return !(l && w && l.h === w.h && l.m === w.m); // the same change on both sides is fine
    });
    if (clash.length) {
        throw new APIError(409, `${branch} changed files you changed too: ${clash.slice(0, 10).join(", ")}${clash.length > 10 ? ", ..." : ""}. Commit first (lizard git commit): the server merges them line by line.`);
    }
    const blobs = await getBlobs(c.repo, toWrite.filter(([p]) => !dirty.has(p)).map(([, f]) => f.h));
    for (const [p, f] of toWrite) {
        if (dirty.has(p)) {
            c.files[p] = { ...local.get(p), h: f.h, m: f.m }; // already identical locally
            continue;
        }
        c.files[p] = writeFile(root, p, blobs.get(f.h), f.m);
        res.updated.push(p);
    }
    for (const p of toRemove) {
        if (!dirty.has(p))
            removeFile(root, p);
        delete c.files[p];
        res.removed.push(p);
    }
    c.base = r.id;
    c.root = r.root;
    c.branch = branch;
    saveCheckout(root, c);
    return res;
}
/**
 * Commit the changed files (all, or those under paths) on the server, then sync to the result:
 * if the branch had moved, the server put the change on top and the new tip has both.
 */
export async function commit(root, c, message, paths, newBranch) {
    const local = scanWorking(root, c);
    const ch = changesOf(c, local);
    const pick = (p) => !paths.length || paths.some((x) => p === x || p.startsWith(x.replace(/\/+$/, "") + "/"));
    const changed = [...ch.added, ...ch.modified].filter(pick);
    const deleted = ch.deleted.filter(pick);
    if (!changed.length && !deleted.length)
        throw new APIError(400, "nothing to commit: no changes");
    // Upload only the contents the server doesn't have.
    const hashes = [...new Set(changed.map((p) => local.get(p).h))];
    const missing = new Set();
    for (let i = 0; i < hashes.length; i += 5000) {
        const r = await lg.post(`${repoPath(c.repo)}/blobs/missing`, { hashes: hashes.slice(i, i + 5000) });
        for (const h of r.missing)
            missing.add(h);
    }
    const byHash = new Map(changed.map((p) => [local.get(p).h, p]));
    let next = 0;
    const list = [...missing];
    await Promise.all(Array.from({ length: Math.min(6, list.length) }, async () => {
        while (next < list.length) {
            const h = list[next++];
            const p = byHash.get(h);
            const full = safeJoin(root, p);
            const content = local.get(p).m === "120000" ? Buffer.from(readlinkSync(full)) : readFileSync(full);
            if (sha256(content) !== h)
                throw new APIError(409, `${p} changed while committing; try again`);
            await sendRaw("PUT", `${repoPath(c.repo)}/blobs/${h}`, content, { "Content-Type": "application/octet-stream" });
            cachePut("b", h, content);
        }
    }));
    const files = [
        ...changed.map((p) => ({ path: p, hash: local.get(p).h, mode: local.get(p).m })),
        ...deleted.map((p) => ({ path: p, delete: true })),
    ];
    const branch = newBranch ?? c.branch;
    const body = { branch, message, files };
    if (newBranch)
        body.createFrom = c.base;
    else if (c.base)
        body.expect = c.base;
    const r = await lg.post(`${repoPath(c.repo)}/commits`, body);
    // What was sent is now the base for those files.
    for (const p of changed)
        c.files[p] = { ...local.get(p) };
    for (const p of deleted)
        delete c.files[p];
    saveCheckout(root, c);
    const s = await sync(root, c, branch);
    return { sha: r.sha, branch, uploaded: missing.size, files: files.length, sync: s };
}
/** Line diff (Myers), for `lizard git diff`. */
export function unifiedDiff(a, b, path, context = 3) {
    const A = a.split("\n");
    const B = b.split("\n");
    const n = A.length;
    const m = B.length;
    const max = n + m;
    const v = new Array(2 * max + 2).fill(0);
    const trace = [];
    outer: for (let d = 0; d <= max; d++) {
        trace.push(v.slice());
        for (let k = -d; k <= d; k += 2) {
            let x = k === -d || (k !== d && v[max + k - 1] < v[max + k + 1]) ? v[max + k + 1] : v[max + k - 1] + 1;
            let y = x - k;
            while (x < n && y < m && A[x] === B[y]) {
                x++;
                y++;
            }
            v[max + k] = x;
            if (x >= n && y >= m)
                break outer;
        }
    }
    const ops = [];
    let x = n;
    let y = m;
    for (let d = trace.length - 1; d >= 0; d--) {
        const vd = trace[d];
        const k = x - y;
        const pk = k === -d || (k !== d && vd[max + k - 1] < vd[max + k + 1]) ? k + 1 : k - 1;
        const px = vd[max + pk];
        const py = px - pk;
        while (x > px && y > py)
            ops.unshift({ k: " ", t: A[--x], a: x, b: --y });
        if (d > 0) {
            if (x === px)
                ops.unshift({ k: "+", t: B[--y], a: x, b: y });
            else
                ops.unshift({ k: "-", t: A[--x], a: x, b: y });
        }
    }
    const out = [`--- a/${path}`, `+++ b/${path}`];
    for (let i = 0; i < ops.length;) {
        if (ops[i].k === " ") {
            i++;
            continue;
        }
        const start = Math.max(0, i - context);
        let end = i;
        while (end < ops.length) {
            if (ops[end].k !== " ") {
                end++;
                continue;
            }
            let run = 0;
            while (end + run < ops.length && ops[end + run].k === " ")
                run++;
            if (end + run >= ops.length || run > 2 * context) {
                end += Math.min(run, context);
                break;
            }
            end += run;
        }
        const h = ops.slice(start, end);
        const oa = h.filter((o) => o.k !== "+").length;
        const nb = h.filter((o) => o.k !== "-").length;
        out.push(`@@ -${h[0].a + 1},${oa} +${h[0].b + 1},${nb} @@`);
        for (const o of h)
            out.push(o.k + o.t);
        i = end;
    }
    return out.join("\n");
}
//# sourceMappingURL=checkout.js.map