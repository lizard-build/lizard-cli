import { describe, expect, it } from "vitest";
import { stripTerminalControls } from "../../src/lib/terminal.js";

describe("text from others is shown, never obeyed by the terminal", () => {
  it.each([
    ["OSC 52 clipboard write", "a\x1b]52;c;ZWNobyBoaQ==\x07b", "ab"],
    ["OSC 8 hidden link", "\x1b]8;;https://evil\x1b\\click\x1b]8;;\x1b\\", "click"],
    ["cursor up + erase line", "ok\x1b[1A\x1b[2Kfake", "okfake"],
    ["carriage return overwrite", "real\rfake", "realfake"],
    ["8-bit CSI", "a\x9b2Jb", "ab"],
    ["DCS", "a\x1bPq#0;2;0;0;0\x1b\\b", "ab"],
    ["bell, backspace, DEL", "a\x07\x08\x7fb", "ab"],
    ["lone ESC", "a\x1b", "a"],
    ["title set", "\x1b]0;pwned\x07x", "x"],
  ])("%s", (_n, input, want) => expect(stripTerminalControls(input)).toBe(want));

  it("keeps newlines, tabs and ordinary text, unicode included", () => {
    expect(stripTerminalControls("a\tb\nc → é 日本")).toBe("a\tb\nc → é 日本");
  });

  it("colors go unless asked to keep them; with keepColors only colors stay", () => {
    expect(stripTerminalControls("\x1b[31mred\x1b[0m")).toBe("red");
    expect(stripTerminalControls("\x1b[31mred\x1b[0m\x1b[2J\x1b]52;c;x\x07", { keepColors: true })).toBe("\x1b[31mred\x1b[0m");
  });
});
