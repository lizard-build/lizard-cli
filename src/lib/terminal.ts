/**
 * Text that someone else wrote (log lines, issue titles, comments, file contents from the
 * server) can carry terminal control sequences: OSC 52 writes the clipboard, OSC 8 hides a link
 * behind other text, CSI moves the cursor to overwrite what was printed, \r rewrites a line.
 * Printed to a terminal, such text is shown, never obeyed.
 */

// ESC sequences: CSI (ESC [ ... final), OSC (ESC ] ... BEL | ST), DCS/SOS/PM/APC (ESC P|X|^|_ ... ST),
// and two-byte ESC sequences; plus their 8-bit C1 forms (CSI 0x9b, OSC 0x9d, DCS 0x90, ...).
const SEQUENCES =
  /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b\x9c]*(?:\x07|\x1b\\|\x9c)?|\x1b[PX^_][^\x1b\x9c]*(?:\x1b\\|\x9c)?|\x1b[ -/]*[0-~]|\x9b[0-?]*[ -/]*[@-~]|[\x90\x98\x9d\x9e\x9f][^\x07\x1b\x9c]*(?:\x07|\x1b\\|\x9c)?/g;
// SGR (colors, bold): moves nothing, writes nothing; kept for a service's own colored logs.
const SGR = /^\x1b\[[0-9;:]*m$/;
// C0 controls except \t and \n, DEL, and C1 controls.
const CONTROLS = "[\\x00-\\x08\\x0b-\\x1f\\x7f-\\x9f]";
// One pass, sequences first, so a kept color code's ESC is not then stripped as a control.
const ALL = new RegExp(`${SEQUENCES.source}|${CONTROLS}`, "g");

/** text without terminal control sequences or control characters (\n and \t stay). */
export function stripTerminalControls(text: string, opts: { keepColors?: boolean } = {}): string {
  return text.replace(ALL, (m) => (opts.keepColors && SGR.test(m) ? m : ""));
}

/**
 * text made safe for `stream` (stdout by default): stripped when it is a terminal, unchanged
 * when it goes to a file or a pipe (`> log.txt` keeps the bytes the service wrote).
 */
export function termSafe(text: unknown, opts: { keepColors?: boolean; stream?: NodeJS.WriteStream } = {}): string {
  const s = text == null ? "" : String(text);
  return (opts.stream ?? process.stdout).isTTY ? stripTerminalControls(s, opts) : s;
}

/** termSafe for text printed through info()/warn() (stderr). */
export function termSafeErr(text: unknown): string {
  return termSafe(text, { stream: process.stderr });
}
