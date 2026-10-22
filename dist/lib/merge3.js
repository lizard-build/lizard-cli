/**
 * Three-way line merge, as Lizard Git's server merges (lizard-git-server internal/store/merge.go,
 * merge3): the changes each side made to base are combined; changes to different lines (even
 * neighbouring ones) merge, the same change on both sides is taken once, and only lines both
 * sides changed differently conflict. Where the server refuses, this writes both versions
 * between conflict markers, for a person to choose, as git does.
 */
export const MARK_OURS = "<<<<<<< yours";
export const MARK_SEP = "=======";
export const MARK_THEIRS = ">>>>>>>";
/** Lines with their line endings kept (the last one may have none). */
export function splitLines(s) {
    const out = [];
    let start = 0;
    for (let i = 0; i < s.length; i++) {
        if (s[i] === "\n") {
            out.push(s.slice(start, i + 1));
            start = i + 1;
        }
    }
    if (start < s.length)
        out.push(s.slice(start));
    return out;
}
/** Myers' diff of two line lists. */
export function diffLines(A, B) {
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
            ops.unshift({ k: " ", a: --x, b: --y });
        if (d > 0) {
            if (x === px)
                ops.unshift({ k: "+", a: x, b: --y });
            else
                ops.unshift({ k: "-", a: --x, b: y });
        }
    }
    return ops;
}
function changeRegions(base, side) {
    const out = [];
    let cur = null;
    for (const o of diffLines(base, side)) {
        if (o.k === " ") {
            if (cur)
                out.push(cur);
            cur = null;
            continue;
        }
        if (!cur)
            cur = { start: o.a, end: o.a, lines: [] };
        if (o.k === "-")
            cur.end = o.a + 1;
        else
            cur.lines.push(side[o.b]);
    }
    if (cur)
        out.push(cur);
    return out;
}
function overlaps(a, b) {
    // Touching insertions at the same point conflict too, as in git (and the server).
    return (a.start < b.end && b.start < a.end) || a.start === b.start || (a.start === a.end && a.start === b.end) || (b.start === b.end && b.start === a.end);
}
function apply(base, r, rs) {
    let s = "";
    let pos = r.start;
    for (const x of rs) {
        for (; pos < x.start; pos++)
            s += base[pos];
        s += x.lines.join("");
        pos = x.end;
    }
    for (; pos < r.end; pos++)
        s += base[pos];
    return s;
}
const withEOL = (s) => (s === "" || s.endsWith("\n") ? s : s + "\n");
/** Merge ours and theirs over base; conflicting regions are written with markers. */
export function merge3(base, ours, theirs, theirsLabel = "theirs") {
    const b = splitLines(base);
    const co = changeRegions(b, splitLines(ours));
    const ct = changeRegions(b, splitLines(theirs));
    let out = "";
    let conflicts = 0;
    let pos = 0;
    let i = 0;
    let j = 0;
    while (i < co.length || j < ct.length) {
        let r;
        const fromO = [];
        const fromT = [];
        if (j >= ct.length || (i < co.length && co[i].start <= ct[j].start)) {
            r = { start: co[i].start, end: co[i].end };
            fromO.push(co[i++]);
        }
        else {
            r = { start: ct[j].start, end: ct[j].end };
            fromT.push(ct[j++]);
        }
        for (let grew = true; grew;) {
            grew = false;
            while (i < co.length && overlaps(co[i], { ...r, lines: [] })) {
                r = { start: Math.min(r.start, co[i].start), end: Math.max(r.end, co[i].end) };
                fromO.push(co[i++]);
                grew = true;
            }
            while (j < ct.length && overlaps(ct[j], { ...r, lines: [] })) {
                r = { start: Math.min(r.start, ct[j].start), end: Math.max(r.end, ct[j].end) };
                fromT.push(ct[j++]);
                grew = true;
            }
        }
        for (; pos < r.start; pos++)
            out += b[pos];
        if (!fromT.length)
            out += apply(b, r, fromO);
        else if (!fromO.length)
            out += apply(b, r, fromT);
        else {
            const mo = apply(b, r, fromO);
            const mt = apply(b, r, fromT);
            if (mo === mt)
                out += mo;
            else {
                conflicts++;
                out += `${MARK_OURS}\n${withEOL(mo)}${MARK_SEP}\n${withEOL(mt)}${MARK_THEIRS} ${theirsLabel}\n`;
            }
        }
        pos = r.end;
    }
    for (; pos < b.length; pos++)
        out += b[pos];
    return { text: out, conflicts };
}
/** Whether text still holds conflict markers (a whole marker line from merge3). */
export function hasConflictMarkers(text) {
    let ours = false;
    for (const l of text.split("\n")) {
        if (l === MARK_OURS)
            ours = true;
        else if (ours && l.startsWith(MARK_THEIRS + " "))
            return true;
    }
    return false;
}
//# sourceMappingURL=merge3.js.map