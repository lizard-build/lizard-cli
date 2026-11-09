// Support tickets from the CLI: what `lizard support` attaches, and the support inbox.
//
// Two small pieces of local state in ~/.lizard/support.json:
//  - the last failed platform calls (method, path, status, error), so a ticket carries the real
//    error even when an agent describes it vaguely;
//  - which support replies have been shown, so a reply is printed after the next commands (twice
//    at most) and then stays in `lizard support show`.
// The inbox is checked after a command at most once a minute (GET /api/support/unread) and
// printed to stderr, so --json output on stdout never changes.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import chalk from "chalk";
import { configDir } from "./config.js";
import { CURRENT_VERSION } from "./updater.js";
import { detectAgent } from "./agent.js";

interface FailedCall { method: string; path: string; status: number | string; error: string; requestId?: string; at: string }
interface SupportState { lastErrors?: FailedCall[]; checkedAt?: number; shown?: Record<string, number> }

const CHECK_EVERY_MS = 60_000;
const SHOW_TIMES = 2;

function stateFile(): string { return path.join(configDir(), "support.json"); }

function load(): SupportState {
  try { return JSON.parse(fs.readFileSync(stateFile(), "utf8")) as SupportState; } catch { return {}; }
}

function save(s: SupportState): void {
  try {
    fs.mkdirSync(configDir(), { recursive: true, mode: 0o700 });
    fs.writeFileSync(stateFile(), JSON.stringify(s), { mode: 0o600 });
  } catch { /* best effort */ }
}

/** Called for every failed platform call. Never throws. */
export function recordFailedCall(method: string, urlPath: string, status: number | string, error: string, requestId?: string | null): void {
  if (urlPath.startsWith("/api/support/")) return;
  const s = load();
  const entry: FailedCall = {
    method, path: urlPath.split("?")[0], status,
    error: String(error).replace(/\bliz_[A-Za-z0-9_-]{8,}/g, "liz_[redacted]").slice(0, 400),
    ...(requestId ? { requestId } : {}), at: new Date().toISOString(),
  };
  s.lastErrors = [...(s.lastErrors ?? []), entry].slice(-5);
  save(s);
}

/** What a new ticket carries besides the message. Only the last hour's failures. */
export function ticketContext(): Record<string, unknown> {
  const hourAgo = Date.now() - 3600_000;
  const lastErrors = (load().lastErrors ?? []).filter((e) => Date.parse(e.at) > hourAgo);
  return {
    cliVersion: CURRENT_VERSION,
    os: `${os.platform()} ${os.arch()} node ${process.versions.node}`,
    ...(lastErrors.length ? { lastErrors } : {}),
  };
}

export function agentName(): string | undefined {
  return detectAgent() ?? undefined;
}

/**
 * Whether a failed command ends with the one-line support hint. Almost every error does: the hint
 * is optional and one line, and an agent can't always tell a Lizard bug from its own mistake.
 * Not shown for: sign-in problems (`lizard login` is the fix), cancelled prompts, `lizard support`
 * itself, and AGENT_SUPPORT=0 (the user turned agent tickets off).
 */
export function wantsSupportHint(opts: { status?: number; code?: string; exitCode?: number } = {}): boolean {
  if (process.env.AGENT_SUPPORT === "0") return false;
  if (process.argv.slice(2).includes("support")) return false;
  if (opts.status === 401 || opts.code === "NOT_AUTHENTICATED" || opts.exitCode === 2) return false;
  if (opts.exitCode === 5 || opts.exitCode === 130) return false;
  return true;
}

export const SUPPORT_HINT = 'Lizard bug? Optional: lizard support open "<what happened>"';

interface UnreadTicket { ticket: string; subject: string; status: string; messages: Array<{ from: string; body: string; at: string }> }

/**
 * Prints support replies the user has not seen yet, after a command. Throttled to one request
 * a minute; each reply is printed at most twice. Never throws and never waits more than 2 s.
 */
export async function printSupportInbox(fetchUnread: () => Promise<{ tickets: UnreadTicket[] }>, opts: { force?: boolean } = {}): Promise<void> {
  try {
    const s = load();
    if (!opts.force && s.checkedAt && Date.now() - s.checkedAt < CHECK_EVERY_MS) return;
    s.checkedAt = Date.now();
    save(s);
    const res = await Promise.race([
      fetchUnread(),
      new Promise<null>((r) => setTimeout(() => r(null), 2000).unref()),
    ]);
    if (!res?.tickets?.length) return;
    const shown = { ...(load().shown ?? {}) };
    const out: string[] = [];
    for (const t of res.tickets) {
      const fresh = t.messages.filter((m) => (shown[`${t.ticket}@${m.at}`] ?? 0) < SHOW_TIMES);
      if (!fresh.length) continue;
      out.push(chalk.bold.green(`📬 Lizard support replied on ${t.ticket}`) + chalk.dim(` (${t.subject})`));
      for (const m of fresh) {
        shown[`${t.ticket}@${m.at}`] = (shown[`${t.ticket}@${m.at}`] ?? 0) + 1;
        out.push(chalk.dim(`   ${m.from}:`));
        for (const line of m.body.split("\n")) out.push(`   ${line}`);
      }
      out.push(chalk.dim(`   → answer: lizard support reply ${t.ticket} "<your answer>"   ·   full thread: lizard support show ${t.ticket}`));
    }
    // Forget entries for replies that are no longer unread.
    const live = new Set(res.tickets.flatMap((t) => t.messages.map((m) => `${t.ticket}@${m.at}`)));
    const next = load();
    next.shown = Object.fromEntries(Object.entries(shown).filter(([k]) => live.has(k)));
    save(next);
    if (out.length) process.stderr.write("\n" + out.join("\n") + "\n");
  } catch { /* the inbox must never break a command */ }
}
