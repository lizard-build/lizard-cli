import chalk from "chalk";

export function isTTY(): boolean {
  return Boolean(process.stdout.isTTY);
}

let jsonMode = false;
export function setJSONMode(on: boolean) {
  jsonMode = on;
}
export function isJSONMode(): boolean {
  return jsonMode;
}

export function printJSON(data: unknown) {
  console.log(JSON.stringify(data, null, 2));
}

/**
 * Terminate with a stable error contract. In JSON mode emit the same
 * `{ error: { code, status, message, body } }` envelope on stdout that the
 * top-level catch in index.ts produces; otherwise print a human "Error:" line
 * on stderr. Use for validation/guard exits that would otherwise bypass the
 * envelope by calling error() + process.exit() directly, leaving agents with
 * empty stdout. `exitCode` is preserved verbatim so callers keep their
 * semantics (2 = auth, 3 = not found, 127 = command not found, …).
 */
export function fail(msg: string, exitCode = 1, code = "ERROR"): never {
  if (jsonMode) {
    printJSON({ error: { code, status: null, message: msg, body: null } });
  } else {
    error(msg);
  }
  process.exit(exitCode);
}

export function success(msg: string) {
  if (jsonMode) return;
  process.stderr.write(chalk.green("✓") + " " + msg + "\n");
}

export function error(msg: string) {
  process.stderr.write(chalk.red("Error:") + " " + msg + "\n");
}

export function warn(msg: string) {
  process.stderr.write(chalk.yellow("Warning:") + " " + msg + "\n");
}

export function info(msg: string) {
  if (jsonMode) return;
  process.stderr.write(msg + "\n");
}

export function link(url: string, text?: string): string {
  const label = text ?? url;
  if (!isTTY()) return label;
  return `\x1b]8;;${url}\x1b\\${label}\x1b]8;;\x1b\\`;
}

const ANSI_RE = /\x1b\[[0-9;]*m/g;
function visibleLength(s: string): number {
  return s.replace(ANSI_RE, "").length;
}
function padVisible(s: string, width: number): string {
  return s + " ".repeat(Math.max(0, width - visibleLength(s)));
}

export function table(
  headers: string[],
  rows: string[][],
) {
  if (rows.length === 0) return;

  const widths = headers.map((h) => visibleLength(h));
  for (const row of rows) {
    for (let i = 0; i < row.length; i++) {
      if (i < widths.length) {
        widths[i] = Math.max(widths[i], visibleLength(row[i] || ""));
      }
    }
  }

  const header = headers
    .map((h, i) => padVisible(h.toUpperCase(), widths[i]))
    .join("  ");
  console.log(chalk.dim(header));

  for (const row of rows) {
    const line = headers
      .map((_, i) => padVisible(row[i] || "", widths[i]))
      .join("  ");
    console.log(line);
  }
}

export function statusColor(status: string): string {
  switch (status) {
    case "running":
      return chalk.green(status);
    case "failed":
    case "error":
      return chalk.red(status);
    case "building":
    case "deploying":
    case "restarting":
    case "pending":
      return chalk.yellow(status);
    case "deleting":
      return chalk.dim(status);
    default:
      return status;
  }
}

export function timeAgo(ts: number | string): string {
  const ms = typeof ts === "string" ? Date.parse(ts) : ts;
  const diff = Date.now() - ms;
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
