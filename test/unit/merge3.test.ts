import { describe, expect, it } from "vitest";
import { hasConflictMarkers, merge3 } from "../../src/lib/merge3.js";

const L = (...xs: string[]) => xs.map((x) => x + "\n").join("");
const ten = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`);

describe("merge3 (as the server merges)", () => {
  it("merges changes to different lines, even neighbouring ones", () => {
    const base = L(...ten);
    expect(merge3(base, L("LINE 1", ...ten.slice(1)), L(...ten.slice(0, 9), "LINE 10"))).toEqual({ text: L("LINE 1", ...ten.slice(1, 9), "LINE 10"), conflicts: 0 });
    expect(merge3(base, L(...ten.slice(0, 4), "LINE 5", ...ten.slice(5)), L(...ten.slice(0, 5), "LINE 6", ...ten.slice(6))).text)
      .toBe(L(...ten.slice(0, 4), "LINE 5", "LINE 6", ...ten.slice(6)));
  });
  it("takes the same change once", () => {
    const x = L(...ten.slice(0, 4), "SAME", ...ten.slice(5));
    expect(merge3(L(...ten), x, x)).toEqual({ text: x, conflicts: 0 });
  });
  it("marks lines both changed differently, and merges the rest", () => {
    const base = L(...ten);
    const r = merge3(base, L("TOP", ...ten.slice(1, 4), "OURS", ...ten.slice(5)), L(...ten.slice(0, 4), "THEIRS", ...ten.slice(5, 9), "BOTTOM"), "main");
    expect(r.conflicts).toBe(1);
    expect(r.text).toBe(L("TOP", ...ten.slice(1, 4), "<<<<<<< yours", "OURS", "=======", "THEIRS", ">>>>>>> main", ...ten.slice(5, 9), "BOTTOM"));
    expect(hasConflictMarkers(r.text)).toBe(true);
  });
  it("both appending at the end conflicts (as in git)", () => {
    const r = merge3(L("a"), L("a", "ours"), L("a", "theirs"));
    expect(r.conflicts).toBe(1);
  });
  it("keeps CRLF and a missing final newline", () => {
    expect(merge3("a\r\nb\r\nc\r\nd\r\n", "A\r\nb\r\nc\r\nd\r\n", "a\r\nb\r\nc\r\nD\r\n").text).toBe("A\r\nb\r\nc\r\nD\r\n");
    expect(merge3("a\nb\nc\nd", "A\nb\nc\nd", "a\nb\nc\nD").text).toBe("A\nb\nc\nD");
  });
  it("a file both added differently: everything is one marked region", () => {
    const r = merge3("", "ours\n", "theirs\n");
    expect(r.text).toBe("<<<<<<< yours\nours\n=======\ntheirs\n>>>>>>> theirs\n");
  });
  it("marker detection needs whole marker lines", () => {
    expect(hasConflictMarkers("x <<<<<<< yours\n")).toBe(false);
    expect(hasConflictMarkers("a\n=======\nb\n")).toBe(false);
  });
});
