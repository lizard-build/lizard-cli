import chalk from "chalk";
import fs from "node:fs";
import { Command, InvalidArgumentError, Option } from "commander";
import { api } from "../lib/api.js";
import { success, info, isJSONMode, printJSON, table, timeAgo, fail } from "../lib/format.js";

// Sandbox schedules: the platform wakes a paused sandbox on a timer, runs a prompt (the coding
// agent) or a shell command in it, and puts it back to sleep. Server: /api/sandboxes/:id/schedules
// and /api/sandbox-schedules/:sid.

interface Schedule {
  id: string; sandboxId: string; name: string | null;
  every: string | null; cron: string | null; timezone: string;
  kind: "prompt" | "command"; prompt: string | null; command: string | null;
  agent: string | null; model: string | null; timeoutSeconds: number; keepMemory: boolean;
  enabled: boolean; disabledReason: string | null; nextRunAt: string | null; running: boolean;
  lastRunAt: string | null; lastStatus: string | null; consecutiveFailures: number; skippedCount: number;
}

interface Run {
  id: string; status: string; woke: boolean; slept: boolean; startedAt: string; endedAt: string | null;
  durationMs: number | null; exitCode: number | null; conversationId: string | null; output: string | null; error: string | null;
}

/** "10m", "90s", "2h", or plain seconds -> seconds. */
function parseDuration(v: string): number {
  const m = v.trim().toLowerCase().match(/^(\d+)\s*(s|m|h|d)?$/);
  if (!m) throw new InvalidArgumentError("Use e.g. 30s, 10m, 2h");
  return Number(m[1]) * { s: 1, m: 60, h: 3600, d: 86400 }[(m[2] ?? "s") as "s"];
}

const when = (s: Schedule) => (s.every ? `every ${s.every}` : `cron ${s.cron}${s.timezone !== "UTC" ? ` (${s.timezone})` : ""}`);
const what = (s: Schedule) => {
  const t = (s.kind === "prompt" ? s.prompt : s.command) ?? "";
  const one = t.replace(/\s+/g, " ").trim();
  return `${s.kind === "prompt" ? chalk.cyan(s.agent ?? "agent") : chalk.magenta("$")} ${one.length > 50 ? one.slice(0, 49) + "…" : one}`;
};
const inFuture = (iso: string) => {
  const s = Math.round((Date.parse(iso) - Date.now()) / 1000);
  if (s <= 0) return "now";
  if (s < 60) return `in ${s}s`;
  if (s < 3600) return `in ${Math.round(s / 60)}m`;
  if (s < 86400) return `in ${Math.round(s / 3600)}h`;
  return `in ${Math.round(s / 86400)}d`;
};
const runStatus = (st: string | null) =>
  !st ? chalk.dim("-") : st === "succeeded" ? chalk.green(st) : st === "running" ? chalk.yellow(st) : chalk.red(st);

function printSchedule(s: Schedule) {
  console.log(`${chalk.bold(s.id)}${s.name ? `  ${s.name}` : ""}  ${s.enabled ? chalk.green("on") : chalk.dim("off")}`);
  console.log(`  sandbox   ${s.sandboxId}`);
  console.log(`  when      ${when(s)}${s.enabled && s.nextRunAt ? chalk.dim(`  (next ${inFuture(s.nextRunAt)})`) : ""}`);
  console.log(`  runs      ${what(s)}`);
  console.log(`  timeout   ${s.timeoutSeconds}s${s.keepMemory ? "   sleeps with memory" : ""}`);
  if (s.lastRunAt) console.log(`  last run  ${runStatus(s.running ? "running" : s.lastStatus)} ${chalk.dim(timeAgo(s.lastRunAt))}`);
  if (s.disabledReason) console.log(chalk.yellow(`  off: ${s.disabledReason}`));
}

function addTaskOptions(c: Command, forCreate: boolean) {
  return c
    .option("--every <interval>", "How often: 1m minimum, e.g. 5m, 1h, 1d")
    .option("--cron <expr>", 'Cron instead: "m h dom mon dow", e.g. "*/5 * * * *", "0 9 * * mon-fri", @daily')
    .option("--tz <zone>", "Time zone for --cron (IANA name, e.g. Europe/Berlin)")
    .option("--prompt <text>", "Run the coding agent with this prompt (a new conversation each run)")
    .option("--prompt-file <path>", "Read the prompt from a file")
    .option("--command <cmd>", "Run this shell command instead (in /workspace, as root)")
    .option("--agent <agent>", "Agent for --prompt (codex, claude, ...)")
    .option("-m, --model <model>", "Model for --prompt")
    .option("--effort <level>", "Reasoning effort for --prompt (minimal, low, medium, high, xhigh)")
    .option("--timeout <duration>", forCreate ? "Stop a run after this long (default 10m)" : "Stop a run after this long", parseDuration)
    // Memory pauses are off for now: a schedule always sleeps files-only. Both flags stay
    // accepted (out of the help) so older scripts still run; --keep-memory is not sent.
    .addOption(new Option("--keep-memory").hideHelp())
    .addOption(new Option("--files-only").hideHelp())
    .option("--name <name>", "A label for the schedule");
}

function taskBody(opts: Record<string, any>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (opts.every) body.every = opts.every;
  if (opts.cron) body.cron = opts.cron;
  if (opts.tz) body.timezone = opts.tz;
  if (opts.promptFile) body.prompt = fs.readFileSync(opts.promptFile, "utf8");
  if (opts.prompt) body.prompt = opts.prompt;
  if (opts.command) body.command = opts.command;
  if (opts.agent) body.agent = opts.agent;
  if (opts.model) body.model = opts.model;
  if (opts.effort) body.reasoningEffort = opts.effort;
  if (opts.timeout) body.timeoutSeconds = opts.timeout;
  if (opts.filesOnly) body.keepMemory = false;
  if (opts.name) body.name = opts.name;
  return body;
}

export function registerSandboxScheduleCommands(sb: Command) {
  addTaskOptions(
    sb.command("schedule")
      .argument("<id>", "Sandbox ID")
      .description("Wake the sandbox on a schedule, run a prompt or command, put it back to sleep"),
    true,
  )
    .option("--disabled", "Create it switched off")
    .addHelpText("after", `
Each run: a paused sandbox is woken (about a second), the prompt or command runs, and the
sandbox goes back to sleep (files only: processes end). A sandbox that was already running is
left running. You pay only while it is awake. Files in /workspace carry over between runs.

A run that is still going when the next one is due makes that one skip. Five failed runs in
a row switch the schedule off.

Examples:
  lizard sandbox schedule sb_abc123 --every 5m --prompt "Continue the research in /workspace/research; append findings to notes.md"
  lizard sandbox schedule sb_abc123 --every 10m --command "python3 /workspace/job.py"
  lizard sandbox schedule sb_abc123 --cron "0 9 * * mon-fri" --tz Europe/Berlin --command "./report.sh"`)
    .action(async (id: string, opts) => {
      if (!opts.every && !opts.cron) fail("Say how often: --every 5m, or --cron \"*/5 * * * *\"", 2, "USAGE");
      if (!opts.prompt && !opts.promptFile && !opts.command) fail("Say what to run: --prompt \"...\" or --command \"...\"", 2, "USAGE");
      const body = taskBody(opts);
      if (opts.disabled) body.enabled = false;
      const s = await api.post<Schedule>(`/api/sandboxes/${id}/schedules`, body);
      if (isJSONMode()) return printJSON(s);
      success(`Scheduled ${chalk.bold(s.id)}: ${when(s)}${s.nextRunAt ? `, first run ${inFuture(s.nextRunAt)}` : ""}`);
      info(chalk.dim(`  lizard sandbox schedule-run ${s.id}    run it now`));
      info(chalk.dim(`  lizard sandbox schedule-runs ${s.id}   see how runs went`));
    });

  sb.command("schedules")
    .argument("[id]", "Only this sandbox's schedules")
    .description("List sandbox schedules")
    .action(async (id?: string) => {
      const { schedules } = id
        ? await api.get<{ schedules: Schedule[] }>(`/api/sandboxes/${id}/schedules`)
        : await api.get<{ schedules: Schedule[] }>(`/api/sandbox-schedules`);
      if (isJSONMode()) return printJSON(schedules);
      if (!schedules.length) return info("No schedules. Create one: lizard sandbox schedule <id> --every 5m --prompt \"...\"");
      table(["id", "sandbox", "when", "runs", "next", "last"], schedules.map((s) => [
        s.id, s.sandboxId, when(s), what(s),
        !s.enabled ? chalk.dim("off") : s.running ? chalk.yellow("running") : s.nextRunAt ? inFuture(s.nextRunAt) : "-",
        s.lastRunAt ? `${runStatus(s.lastStatus)} ${chalk.dim(timeAgo(s.lastRunAt))}` : chalk.dim("-"),
      ]));
    });

  sb.command("schedule-show")
    .argument("<scheduleId>", "Schedule ID (sch_...)")
    .description("Show a schedule")
    .action(async (sid: string) => {
      const s = await api.get<Schedule>(`/api/sandbox-schedules/${sid}`);
      if (isJSONMode()) return printJSON(s);
      printSchedule(s);
      const text = s.kind === "prompt" ? s.prompt : s.command;
      if (text) console.log(chalk.dim(`\n${text}`));
    });

  addTaskOptions(
    sb.command("schedule-set")
      .argument("<scheduleId>", "Schedule ID (sch_...)")
      .description("Change a schedule: timing, what it runs, or switch it on/off"),
    false,
  )
    .option("--on", "Switch it on")
    .option("--off", "Switch it off")
    .action(async (sid: string, opts) => {
      const body = taskBody(opts);
      if (opts.on) body.enabled = true;
      if (opts.off) body.enabled = false;
      if (!Object.keys(body).length) fail("Nothing to change: give an option, e.g. --every 10m or --off", 2, "USAGE");
      const s = await api.patch<Schedule>(`/api/sandbox-schedules/${sid}`, body);
      if (isJSONMode()) return printJSON(s);
      success(`Updated ${chalk.bold(s.id)}`);
      printSchedule(s);
    });

  sb.command("schedule-run")
    .argument("<scheduleId>", "Schedule ID (sch_...)")
    .description("Run a schedule now (also switches it back on)")
    .option("--wait", "Wait for the run to finish and print it")
    .action(async (sid: string, opts) => {
      const before = await api.get<{ runs: Run[] }>(`/api/sandbox-schedules/${sid}/runs?limit=1`);
      const s = await api.post<Schedule>(`/api/sandbox-schedules/${sid}/run`, {});
      if (!opts.wait) {
        if (isJSONMode()) return printJSON(s);
        return success(`Run of ${chalk.bold(sid)} queued: it starts within a few seconds. See it: lizard sandbox schedule-runs ${sid}`);
      }
      const prev = before.runs[0]?.id;
      let run: Run | undefined;
      for (let i = 0; i < 24 * 60 * 6; i++) {
        await new Promise((r) => setTimeout(r, 5000));
        const { runs } = await api.get<{ runs: Run[] }>(`/api/sandbox-schedules/${sid}/runs?limit=1`);
        if (runs[0] && runs[0].id !== prev) { run = runs[0]; if (run.endedAt) break; }
      }
      if (isJSONMode()) return printJSON(run ?? null);
      if (run) printRun(run, true);
    });

  sb.command("schedule-runs")
    .argument("<scheduleId>", "Schedule ID (sch_...)")
    .description("Show a schedule's recent runs; --output prints the latest run's output")
    .option("-n, --limit <n>", "How many runs", "20")
    .option("-o, --output", "Print the latest run's output in full")
    .action(async (sid: string, opts) => {
      const { runs } = await api.get<{ runs: Run[] }>(`/api/sandbox-schedules/${sid}/runs?limit=${Number(opts.limit) || 20}`);
      if (isJSONMode()) return printJSON(runs);
      if (!runs.length) return info("No runs yet.");
      if (opts.output) return printRun(runs[0], true);
      table(["run", "status", "started", "took", "exit", "note"], runs.map((r) => [
        r.id, runStatus(r.status), timeAgo(r.startedAt), r.durationMs != null ? `${Math.round(r.durationMs / 1000)}s` : "-",
        r.exitCode != null ? String(r.exitCode) : "-",
        (r.error ?? (r.output ?? "").trim().split("\n").pop() ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").slice(0, 60),
      ]));
    });

  sb.command("unschedule")
    .alias("schedule-rm")
    .argument("<scheduleId>", "Schedule ID (sch_...)")
    .description("Delete a schedule")
    .action(async (sid: string) => {
      await api.delete(`/api/sandbox-schedules/${sid}`);
      if (isJSONMode()) return printJSON({ id: sid, deleted: true });
      success(`Schedule ${chalk.bold(sid)} deleted`);
    });
}

function printRun(r: Run, full: boolean) {
  const took = r.durationMs != null ? `${Math.round(r.durationMs / 1000)}s` : "still running";
  console.log(`${chalk.bold(r.id)}  ${runStatus(r.status)}  ${chalk.dim(`${timeAgo(r.startedAt)}, ${took}${r.exitCode != null ? `, exit ${r.exitCode}` : ""}${r.woke ? ", woke the sandbox" : ""}${r.slept ? ", back asleep" : ""}`)}`);
  if (r.conversationId) console.log(chalk.dim(`  conversation ${r.conversationId}`));
  if (r.error) console.log(chalk.red(`  ${r.error}`));
  if (full && r.output) console.log(`\n${r.output.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")}`);
}
