import chalk from "chalk";
import { Command } from "commander";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { api, APIError, getRequestToken } from "../lib/api.js";
import { fail, isJSONMode, printJSON, table, timeAgo } from "../lib/format.js";

/**
 * `lizard gha`: run a repository's GitHub Actions jobs on Lizard runners.
 *
 * One rule for people and agents alike: run `lizard gha`, do the one thing it says, run it
 * again. Every answer is worked out from scratch (the platform's /api/gha/status plus the
 * workflow files in this checkout), so it is always safe to repeat, and nothing waits for a
 * browser. Not ready is an answer, not a failure: the exit code is 0 unless something broke
 * (`--require-ready` makes not-ready exit 1, for CI).
 */

type Actor = "user" | "org_owner" | "agent" | "none";
interface Next { actor: Actor; say: string; url?: string; command?: string; confirm?: boolean }
interface Size { name: string; label: string; vcpus: number; memoryGb: number; pricePerHour: number }
interface Status {
  state: string;
  verdict: "READY" | "NOT_READY" | "BLOCKED";
  message: string;
  next: Next;
  repo: string;
  lizardAccount: string | null;
  installationId: number | null;
  trial: { maxSize: string } | null;
  sizes: Size[];
  recentJobs: { id: string; workflow: string | null; job: string; status: string; conclusion: string | null; url: string | null; createdAt: number }[];
}
interface PreviewFile {
  path: string;
  changed: boolean;
  text?: string;
  error?: string;
  moves: { job: string; from: string | null; to: string }[];
  kept: { job: string; runsOn: string | null; reason: string }[];
  already: { job: string; label: string }[];
  unknownLabels: { job: string; label: string }[];
}
interface Preview { files: PreviewFile[]; trial: { maxSize: string; capped: string[]; message: string | null } | null; sizes: Size[] }

// ── The repository ─────────────────────────────────────────────────────

const REPO_RE = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;

function git(args: string[], cwd = process.cwd()): string | null {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

/** owner/name from a GitHub remote URL (https, ssh or git@), or null. */
export function repoFromRemote(url: string): string | null {
  const m = url.trim().match(/github\.com[:/]+([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

interface RepoContext { repo: string; root: string | null; fromFlag: boolean }

function resolveRepo(flag?: string): RepoContext {
  const root = git(["rev-parse", "--show-toplevel"]);
  if (flag) {
    if (!REPO_RE.test(flag)) fail(`--repo must look like owner/name (got "${flag}")`, 1, "BAD_REPO");
    // The local files are only this repository's when the checkout is that repository.
    const here = root ? repoFromRemote(git(["remote", "get-url", "origin"], root) ?? "") : null;
    return { repo: flag, root: here && here.toLowerCase() === flag.toLowerCase() ? root : null, fromFlag: true };
  }
  if (!root) {
    fail("This isn't a git repository. Run `lizard gha` inside your repository, or pass --repo owner/name.", 1, "NOT_A_REPO");
  }
  const remotes = (git(["remote"], root) ?? "").split("\n").filter(Boolean);
  const order = ["origin", ...remotes.filter((r) => r !== "origin")];
  for (const r of order) {
    const repo = repoFromRemote(git(["remote", "get-url", r], root) ?? "");
    if (repo) return { repo, root, fromFlag: false };
  }
  return fail("This repository has no GitHub remote. Push it to a GitHub organization first, or pass --repo owner/name.", 1, "NO_GITHUB_REMOTE");
}

/** A command to show, carrying --repo when the user gave one. */
function cmd(base: string, ctx: RepoContext): string {
  return ctx.fromFlag && base.startsWith("lizard gha") ? `${base} --repo ${ctx.repo}` : base;
}

function readWorkflows(root: string): { path: string; text: string }[] {
  const dir = path.join(root, ".github", "workflows");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /\.ya?ml$/.test(f))
    .sort()
    .slice(0, 50)
    .map((f) => ({ path: `.github/workflows/${f}`, text: readFileSync(path.join(dir, f), "utf8") }));
}

/**
 * Is this checkout behind GitHub with different workflow files there? Then the local files say
 * nothing about what runs: GitHub runs what's on the branch. Fetches the branch's upstream first
 * (10 s at most; offline just uses what was last fetched).
 */
function outOfDate(root: string): { behind: number; upstream: string } | null {
  const upstream = git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], root);
  if (!upstream) return null;
  const [remote, ...rest] = upstream.split("/");
  try {
    execFileSync("git", ["fetch", "--quiet", remote, rest.join("/")], { cwd: root, stdio: "ignore", timeout: 10_000 });
  } catch { /* offline: compare with what we have */ }
  const behind = Number(git(["rev-list", "--count", `HEAD..${upstream}`], root) ?? "0");
  if (!behind) return null;
  try {
    execFileSync("git", ["diff", "--quiet", "HEAD", upstream, "--", ".github/workflows"], { cwd: root, stdio: "ignore" });
    return null; // same workflow files: the local ones are accurate
  } catch {
    return { behind, upstream };
  }
}

function workflowsUncommitted(root: string): boolean {
  const out = git(["status", "--porcelain", "--", ".github/workflows"], root);
  return !!out && out.length > 0;
}

// ── Talking to the platform ────────────────────────────────────────────

async function getStatus(ctx: RepoContext): Promise<Status> {
  try {
    const s = await api.get<Status>(`/api/gha/status?repo=${encodeURIComponent(ctx.repo)}`);
    if (s.next.command) s.next.command = cmd(s.next.command, ctx);
    return s;
  } catch (e) {
    if (e instanceof APIError && e.status === 401 && (getRequestToken() ?? "").startsWith("liz_")) {
      fail("Setting up GitHub Actions needs your own login, not an API key. Run `lizard login` (or unset LIZARD_TOKEN) and try again.", 2, "API_KEY_NOT_ALLOWED");
    }
    if (e instanceof APIError && e.status === 403) {
      fail("This API key is limited to a project or workspace, and GitHub Actions setup is account-wide. Run `lizard login` and try again.", 2, "SCOPED_KEY_NOT_ALLOWED");
    }
    throw e;
  }
}

async function getPreview(files: { path: string; text: string }[], opts: { size?: string; jobs?: Record<string, string>; cache?: boolean; docker?: boolean }): Promise<Preview> {
  return api.post<Preview>("/api/gha/preview", { files, size: opts.size, jobs: opts.jobs, cache: !!opts.cache, docker: !!opts.docker });
}

// ── Working out the whole picture ──────────────────────────────────────

interface Report extends Status {
  /** Present once the organization is ready: what this checkout's workflows still need. */
  workflows?: {
    toMove: { file: string; job: string; from: string | null; to: string }[];
    onLizard: { file: string; job: string; label: string }[];
    notMovable: { file: string; job: string; runsOn: string | null; reason: string }[];
    unknownLabels: { file: string; job: string; label: string }[];
    errors: { file: string; error: string }[];
    uncommitted: boolean;
  };
}

async function report(ctx: RepoContext): Promise<Report> {
  const s: Report = await getStatus(ctx);
  if (s.verdict !== "READY") return s;
  if (!ctx.root) {
    // Another repository than this checkout: only the platform's side is known.
    s.next = { actor: "agent", say: `${s.repo} is connected. Run this inside a checkout of ${s.repo} to move its workflows.`, command: "lizard gha migrate --dry-run" };
    return s;
  }
  const stale = outOfDate(ctx.root);
  if (stale) {
    s.state = "CHECKOUT_OUT_OF_DATE";
    s.verdict = "NOT_READY";
    s.message = `${s.repo} is connected, but this checkout is ${stale.behind} commit${stale.behind === 1 ? "" : "s"} behind ${stale.upstream} and its workflow files differ, so they don't show what GitHub runs.`;
    s.next = { actor: "agent", confirm: true, say: "Update this checkout first so its workflow files match GitHub (git pull), then check again.", command: `git pull && ${cmd("lizard gha", ctx)}` };
    return s;
  }
  const files = readWorkflows(ctx.root);
  if (!files.length) {
    s.state = "NO_WORKFLOWS";
    s.message = `${s.repo} is connected, but this checkout has no workflow files in .github/workflows.`;
    s.next = { actor: "agent", say: "Add a GitHub Actions workflow with `runs-on: lizard-medium-ubuntu-2404` (or move an existing one here), then run `lizard gha` again.", command: cmd("lizard gha", ctx) };
    return s;
  }
  const p = await getPreview(files, {});
  const w: NonNullable<Report["workflows"]> = { toMove: [], onLizard: [], notMovable: [], unknownLabels: [], errors: [], uncommitted: workflowsUncommitted(ctx.root) };
  for (const f of p.files) {
    if (f.error) w.errors.push({ file: f.path, error: f.error });
    for (const m of f.moves) w.toMove.push({ file: f.path, ...m });
    for (const a of f.already) w.onLizard.push({ file: f.path, ...a });
    for (const k of f.kept) w.notMovable.push({ file: f.path, ...k });
    for (const u of f.unknownLabels) w.unknownLabels.push({ file: f.path, ...u });
  }
  s.workflows = w;

  if (w.unknownLabels.length) {
    const u = w.unknownLabels[0];
    s.state = "UNKNOWN_LABEL";
    s.verdict = "NOT_READY";
    s.message = `${u.file} asks for "${u.label}", which isn't a Lizard runner, so that job would wait forever.`;
    s.next = { actor: "agent", say: `Change runs-on to one of: ${s.sizes.map((z) => z.label).join(", ")}. Or run \`lizard gha migrate\` to fix it for you.`, command: cmd("lizard gha migrate --dry-run", ctx) };
  } else if (w.toMove.length) {
    s.state = "NEEDS_MIGRATION";
    s.message = `${s.repo} is connected. ${w.toMove.length} job${w.toMove.length === 1 ? "" : "s"} still run${w.toMove.length === 1 ? "s" : ""} on GitHub's runners.`;
    s.next = { actor: "agent", say: "Preview the change, then apply it. It only edits runs-on lines in .github/workflows; nothing on GitHub changes until you commit and push.", command: cmd("lizard gha migrate --dry-run", ctx) };
  } else if (w.onLizard.length && w.uncommitted) {
    s.state = "NOT_PUSHED";
    s.message = "The workflows here use Lizard runners, but the change isn't committed yet.";
    s.next = { actor: "agent", say: `Commit and push the changes in .github/workflows (or open a pull request) the way you normally would: the next run uses Lizard runners. Afterwards, \`${cmd("lizard gha", ctx)}\` confirms the first job ran.` };
  } else if (w.onLizard.length && !s.recentJobs.length) {
    s.state = "WAITING_FOR_FIRST_RUN";
    s.message = "The workflows use Lizard runners. No job has run on Lizard yet.";
    s.next = { actor: "agent", say: "Make sure the change is pushed to GitHub. Jobs show up here as soon as a workflow runs.", command: cmd("lizard gha jobs", ctx) };
  } else if (w.onLizard.length) {
    const j = s.recentJobs[0];
    s.state = "ACTIVE";
    s.message = `${s.repo} runs on Lizard. Last job: ${j.job} (${j.conclusion ?? j.status}, ${timeAgo(j.createdAt)}).`;
    s.next = { actor: "none", say: "All set: GitHub Actions jobs for this repository run on Lizard runners.", command: cmd("lizard gha jobs", ctx) };
  } else {
    s.state = "NOTHING_TO_MOVE";
    s.message = "None of this repository's jobs can move to Lizard runners (only Linux jobs on GitHub-hosted or sized runners can).";
    s.next = { actor: "none", say: "Nothing to do. macOS, Windows and expression-based jobs stay where they are." };
  }
  return s;
}

// ── Printing ───────────────────────────────────────────────────────────

const VERDICT_TEXT: Record<Report["verdict"], string> = {
  READY: chalk.green("✓ Ready"),
  NOT_READY: chalk.yellow("● Not ready yet"),
  BLOCKED: chalk.red("✗ Can't continue"),
};

const WHO: Record<Actor, string> = {
  user: "What you need to do",
  org_owner: "What an owner of the GitHub organization needs to do",
  agent: "Next step",
  none: "Status",
};

function money(n: number): string {
  return `$${n.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}/h`;
}

function printReport(r: Report) {
  const lines: string[] = [];
  lines.push(chalk.bold(`GitHub Actions on Lizard · ${r.repo}`));
  lines.push("");
  lines.push(`${VERDICT_TEXT[r.verdict]}: ${r.message}`);
  if (r.workflows) {
    const w = r.workflows;
    if (w.toMove.length) {
      lines.push("");
      lines.push(chalk.dim("Jobs that would move:"));
      for (const m of w.toMove) lines.push(`  ${m.file}  ${chalk.bold(m.job)}  ${m.from ?? "?"} → ${chalk.cyan(m.to)}`);
    }
    if (w.onLizard.length && (r.state === "ACTIVE" || r.state === "WAITING_FOR_FIRST_RUN" || r.state === "NOT_PUSHED")) {
      lines.push("");
      lines.push(chalk.dim("On Lizard runners:"));
      for (const a of w.onLizard) lines.push(`  ${a.file}  ${chalk.bold(a.job)}  ${chalk.cyan(a.label)}`);
    }
    if (w.notMovable.length) {
      lines.push("");
      lines.push(chalk.dim("Staying where they are:"));
      for (const k of w.notMovable) lines.push(chalk.dim(`  ${k.file}  ${k.job}  (${k.runsOn ?? "no runs-on"}: ${k.reason})`));
    }
    for (const e of w.errors) lines.push(chalk.yellow(`  ${e.file}: ${e.error}`));
  }
  lines.push("");
  lines.push(chalk.bold((r.next.confirm ? "Needs your OK" : WHO[r.next.actor]) + ":"));
  lines.push("  " + r.next.say);
  if (r.next.url) lines.push("  " + chalk.cyan(r.next.url));
  if (r.next.command && r.next.actor !== "none") {
    lines.push("");
    lines.push((r.next.confirm ? "If yes, run: " : r.next.url || r.next.actor === "user" || r.next.actor === "org_owner" ? "Then run: " : "Run: ") + chalk.cyan(r.next.command));
  }
  if (r.verdict === "READY" && r.sizes?.length && (r.state === "NEEDS_MIGRATION")) {
    lines.push("");
    lines.push(chalk.dim("Runner sizes (billed per second while a job runs): " + r.sizes.map((s) => `${s.name} ${s.vcpus} vCPU/${s.memoryGb} GB ${money(s.pricePerHour)}`).join(" · ")));
    if (r.trial) lines.push(chalk.dim("Your account hasn't paid yet, so only small runners are available until you add credit."));
  }
  console.log(lines.join("\n"));
}

/** For agents: one line saying how to act on `next`. */
function howToUse(n: Next): string {
  if (n.confirm) return "Ask the user first: show them next.say. Run next.command only if they agree.";
  if (n.actor === "user" || n.actor === "org_owner") {
    return "A person has to do this. Show the user next.say and next.url exactly as written, wait until they say it's done, then run next.command.";
  }
  if (n.actor === "agent" && n.command) return "You can do this yourself: run next.command.";
  if (n.actor === "agent") return "You can do this yourself: next.say says what.";
  return "Nothing left to do. Tell the user next.say.";
}

function jsonOut(r: Report) {
  printJSON({ ...r, howToUse: howToUse(r.next) });
}

function finish(r: Report, requireReady: boolean) {
  if (isJSONMode()) jsonOut(r); else printReport(r);
  if (requireReady && r.verdict !== "READY") process.exitCode = 1;
}

// ── Commands ───────────────────────────────────────────────────────────

function parseJobSizes(values: string[] | undefined): Record<string, string> | undefined {
  if (!values?.length) return undefined;
  const out: Record<string, string> = {};
  for (const v of values) {
    const m = v.match(/^([^=]+)=(small|medium|large)$/);
    if (!m) fail(`--job must look like build=large (got "${v}"). Sizes: small, medium, large.`, 1, "BAD_JOB_SIZE");
    out[m[1]] = m[2];
  }
  return out;
}

export function registerGha(program: Command) {
  const gha = program
    .command("gha")
    .description("Run this repository's GitHub Actions jobs on Lizard runners: shows where setup stands and the one next step")
    .option("--repo <owner/name>", "GitHub repository (default: this checkout's GitHub remote)")
    .option("--require-ready", "Exit 1 unless the repository is ready (for CI)")
    .addHelpText("after", `
How it works:
  Run \`lizard gha\`, do the one thing it says, then run it again. It never waits:
  steps that happen in a browser print a link and the command to run afterwards.

  lizard gha                  where setup stands + the next step
  lizard gha connect          connect the GitHub organization to your Lizard account
  lizard gha migrate          switch runs-on in .github/workflows to Lizard runners
  lizard gha jobs             recent jobs on Lizard runners

Runners: lizard-small-ubuntu-2404 (2 vCPU), lizard-medium-ubuntu-2404 (4 vCPU),
lizard-large-ubuntu-2404 (8 vCPU), billed per second. GitHub organizations only.`)
    .action(async (opts: { repo?: string; requireReady?: boolean }) => {
      const ctx = resolveRepo(opts.repo);
      finish(await report(ctx), !!opts.requireReady);
    });

  gha
    .command("connect")
    .description("Connect this repository's GitHub organization to your Lizard account (your account pays for its runners)")
    .option("--repo <owner/name>", "GitHub repository (default: this checkout's GitHub remote)")
    .action(async (opts: { repo?: string }, c: Command) => {
      const ctx = resolveRepo(opts.repo ?? c.parent?.opts().repo);
      const before = await getStatus(ctx);
      if (before.state === "NOT_CONNECTED" && before.installationId) {
        try {
          await api.post(`/api/gha/installations/${before.installationId}/connect`);
        } catch (e) {
          if (!(e instanceof APIError)) throw e;
          // The platform's reason, then where things stand.
          if (!isJSONMode()) console.log(chalk.yellow(`Couldn't connect: ${e.message}`) + "\n");
        }
        finish(await report(ctx), false);
        return;
      }
      // Already connected, or something else comes first: say what.
      finish(await report(ctx), false);
    });

  gha
    .command("migrate")
    .description("Switch runs-on in this checkout's .github/workflows to Lizard runners (edits files only; commit and push to apply)")
    .option("--repo <owner/name>", "GitHub repository (default: this checkout's GitHub remote)")
    .option("--size <size>", "Runner size for every job that moves: small, medium or large (default: medium for GitHub's standard runners)")
    .option("--job <job=size...>", "Size for one job, e.g. --job build=large (repeatable)")
    .option("--cache", "Also use Lizard's cached checkout and cache actions (faster repeat runs)")
    .option("--docker", "Also use Lizard's Docker build actions (layers stay cached between runs)")
    .option("--dry-run", "Show what would change without writing anything")
    .option("--force", "Edit the files even if the organization isn't set up yet")
    .action(async (opts: { repo?: string; size?: string; job?: string[]; cache?: boolean; docker?: boolean; dryRun?: boolean; force?: boolean }, c: Command) => {
      const ctx = resolveRepo(opts.repo ?? c.parent?.opts().repo);
      if (opts.size && !["small", "medium", "large"].includes(opts.size)) fail("--size must be small, medium or large", 1, "BAD_SIZE");
      if (!ctx.root) fail(`Run this inside a checkout of ${ctx.repo}: it edits the workflow files on disk.`, 1, "NOT_IN_CHECKOUT");
      const status = await getStatus(ctx);
      if (status.verdict !== "READY" && !opts.force) {
        // Jobs moved before the organization is ready would wait for a runner that never comes.
        if (isJSONMode()) {
          jsonOut({ ...status, message: `Not changing any files yet: ${status.message}` });
        } else {
          console.log(chalk.yellow("Not changing any files yet") + chalk.dim(" — jobs moved now would wait for a runner that can't start.") + "\n");
          printReport(status);
        }
        return;
      }
      const stale = opts.force ? null : outOfDate(ctx.root!);
      if (stale) {
        fail(`This checkout is ${stale.behind} commit${stale.behind === 1 ? "" : "s"} behind ${stale.upstream} and its workflow files differ. Run \`git pull\` first, then \`lizard gha migrate\` again (or pass --force to edit these files anyway).`, 1, "CHECKOUT_OUT_OF_DATE");
      }
      const files = readWorkflows(ctx.root!);
      if (!files.length) fail("No workflow files in .github/workflows.", 1, "NO_WORKFLOWS");
      const p = await getPreview(files, { size: opts.size, jobs: parseJobSizes(opts.job), cache: opts.cache, docker: opts.docker });
      const changed = p.files.filter((f) => f.changed && f.text);
      if (!opts.dryRun) for (const f of changed) writeFileSync(path.join(ctx.root!, f.path), f.text!);

      const moves = p.files.flatMap((f) => f.moves.map((m) => ({ file: f.path, ...m })));
      const kept = p.files.flatMap((f) => f.kept.map((k) => ({ file: f.path, ...k })));
      const errors = p.files.filter((f) => f.error).map((f) => ({ file: f.path, error: f.error! }));
      const next: Next = !changed.length
        ? { actor: "none", say: "Nothing needed changing.", command: cmd("lizard gha", ctx) }
        : opts.dryRun
          ? { actor: "agent", confirm: true, say: `This changes runs-on for ${moves.length} job${moves.length === 1 ? "" : "s"} (listed above) in your workflow files. Apply it?`, command: cmd(`lizard gha migrate${opts.size ? ` --size ${opts.size}` : ""}${(opts.job ?? []).map((j) => ` --job ${j}`).join("")}${opts.cache ? " --cache" : ""}${opts.docker ? " --docker" : ""}`, ctx) }
          : { actor: "agent", say: `Updated ${changed.length === 1 ? "1 workflow file" : `${changed.length} workflow files`}. Commit and push ${changed.length === 1 ? "it" : "them"} (or open a pull request) the way you normally would: the next run uses Lizard runners. Afterwards, \`${cmd("lizard gha", ctx)}\` confirms the first job ran.` };

      if (isJSONMode()) {
        printJSON({
          repo: ctx.repo, dryRun: !!opts.dryRun, filesChanged: changed.map((f) => f.path), moves, kept, errors,
          trial: p.trial, next,
          howToUse: howToUse(next),
        });
        return;
      }
      console.log(chalk.bold(opts.dryRun ? `Preview — nothing written (${ctx.repo})` : `Updated workflows (${ctx.repo})`));
      console.log("");
      if (moves.length) {
        for (const m of moves) console.log(`  ${m.file}  ${chalk.bold(m.job)}  ${m.from ?? "?"} → ${chalk.cyan(m.to)}`);
      } else {
        console.log(chalk.dim("  No jobs to move."));
      }
      if (kept.length) {
        console.log("");
        console.log(chalk.dim("Staying where they are:"));
        for (const k of kept) console.log(chalk.dim(`  ${k.file}  ${k.job}  (${k.runsOn ?? "no runs-on"}: ${k.reason})`));
      }
      for (const e of errors) console.log(chalk.yellow(`  ${e.file}: ${e.error}`));
      if (p.trial?.message) console.log("\n" + chalk.yellow(p.trial.message));
      console.log("");
      console.log(chalk.bold(next.confirm ? "Needs your OK:" : "Next step:"));
      console.log("  " + next.say);
      if (next.command && next.actor !== "none") console.log("\n" + (next.confirm ? "If yes, run: " : "Run: ") + chalk.cyan(next.command));
    });

  gha
    .command("jobs")
    .description("Recent GitHub Actions jobs that ran on Lizard runners for this repository")
    .option("--repo <owner/name>", "GitHub repository (default: this checkout's GitHub remote)")
    .option("--all", "Jobs of every repository you connected, not just this one")
    .option("--limit <n>", "How many jobs (default 20)", "20")
    .action(async (opts: { repo?: string; all?: boolean; limit: string }, c: Command) => {
      const repoFlag = opts.repo ?? c.parent?.opts().repo;
      const ctx = opts.all && !repoFlag ? null : resolveRepo(repoFlag);
      const limit = Math.min(200, Math.max(1, Number(opts.limit) || 20));
      const { jobs } = await api.get<{ jobs: any[] }>(`/api/gha/jobs?limit=200`);
      const mine = (ctx ? jobs.filter((j) => String(j.repo).toLowerCase() === ctx.repo.toLowerCase()) : jobs).slice(0, limit);
      if (isJSONMode()) {
        printJSON({
          repo: ctx?.repo ?? null,
          jobs: mine.map((j) => ({ id: j.id, repo: j.repo, workflow: j.workflow, job: j.job, status: j.status, conclusion: j.conclusion, branch: j.branch, url: j.url, runner: j.runner, createdAt: j.createdAt, finishedAt: j.finishedAt, error: j.vmError })),
          ...(mine.length ? {} : { next: { actor: "agent", say: "No jobs on Lizard runners yet. Run `lizard gha` to see what's missing.", command: ctx ? cmd("lizard gha", ctx) : "lizard gha" } }),
        });
        return;
      }
      if (!mine.length) {
        console.log(`No jobs on Lizard runners yet${ctx ? ` for ${ctx.repo}` : ""}. Run ${chalk.cyan(ctx ? cmd("lizard gha", ctx) : "lizard gha")} to see what's missing.`);
        return;
      }
      table(
        ["when", ...(ctx ? [] : ["repo"]), "workflow", "job", "result", "branch"],
        mine.map((j) => [
          timeAgo(j.createdAt), ...(ctx ? [] : [j.repo]), j.workflow ?? "", j.job,
          j.conclusion === "success" ? chalk.green("passed") : j.conclusion === "failure" ? chalk.red("failed") : j.conclusion ? j.conclusion : chalk.yellow(j.status),
          j.branch ?? "",
        ]),
      );
      const failedVm = mine.find((j) => j.vmError);
      if (failedVm) console.log("\n" + chalk.yellow(`A runner failed to start for ${failedVm.job}: ${failedVm.vmError}`));
    });
}
