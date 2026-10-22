import chalk from "chalk";
import { Command } from "commander";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { basename } from "node:path";
import { APIError } from "../lib/api.js";
import { isJSONMode, printJSON, table, success, info, warn, link } from "../lib/format.js";
import {
  lg, qs, seg, segs, resolveRepo, repoPath, myLogin, gitURL, ago, ACTIVE_RUN,
} from "../lib/lizard-git.js";
import * as wc from "../lib/checkout.js";

/**
 * Lizard Git (lizard.build/git) from the terminal: repositories, issues, pull requests,
 * reviews, CI runs, releases, secrets, collaborators, webhooks, branch rules, labels,
 * notifications, tokens; and working copies: clone, status, diff, commit, sync, switch. Lizard
 * Git is Scion-style (no git protocol): a checkout holds files and .lizard-git/checkout.json, and
 * every commit is made on the server (lib/checkout.ts).
 *
 * Registered under `lizard git`, next to the GitHub integration commands.
 */

const collect = (v: string, prev: string[]) => [...prev, v];
const list = (v?: string) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined);
const int = (v: string) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new APIError(400, `expected a number, got "${v}"`);
  return n;
};

/** Print data in JSON mode, or run the human printer. */
function out(data: unknown, human: () => void) {
  if (isJSONMode()) printJSON(data ?? { ok: true });
  else human();
}

function done(data: unknown, msg: string) {
  out(data ?? { ok: true }, () => success(msg));
}

function state(s: string): string {
  switch (s) {
    case "success": case "merged": case "approved": return chalk.green(s);
    case "failure": case "error": case "changes_requested": return chalk.red(s);
    case "open": return chalk.green(s);
    case "closed": case "cancelled": case "skipped": return chalk.dim(s);
    case "queued": case "running": case "waiting": case "pending": return chalk.yellow(s);
    default: return s;
  }
}

/** Text from --body, --body-file, or "" */
function bodyFrom(opts: { body?: string; bodyFile?: string }): string | undefined {
  if (opts.bodyFile) return opts.bodyFile === "-" ? readFileSync(0, "utf8") : readFileSync(opts.bodyFile, "utf8");
  return opts.body;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The checkout this directory is in, or a clear error. */
function needCheckout(): string {
  const root = wc.findCheckout();
  if (!root) throw new APIError(400, "not in a Lizard Git checkout (lizard git clone owner/name)");
  return root;
}

/** `lizard git status` inside a checkout: your changes. */
export function checkoutStatus(): boolean {
  const root = wc.findCheckout();
  if (!root) return false;
  const c = wc.loadCheckout(root);
  const ch = wc.changesOf(c, wc.scanWorking(root, c));
  const unpushed = (c.pending?.commits ?? []).map((x) => ({ message: x.message.trim(), time: x.time, files: x.files.length }));
  out({ repo: c.repo, branch: c.branch, commit: c.base, sparse: c.sparse, ...ch, unpushed }, () => {
    info(`${chalk.bold(c.repo)} on ${chalk.cyan(c.branch)} at ${c.base.slice(0, 12)}${c.sparse ? chalk.dim(` (sparse: ${c.sparse.join(", ")})`) : ""}`);
    if (unpushed.length) {
      info(`${chalk.yellow(`${unpushed.length} commit${unpushed.length === 1 ? "" : "s"} not pushed`)} ${chalk.dim("(lizard git push)")}`);
      for (const u of unpushed) info(`  ${chalk.dim("•")} ${u.message.split("\n")[0]}`);
    }
    const n = ch.added.length + ch.modified.length + ch.deleted.length;
    if (!n) return info(chalk.dim("no changes"));
    for (const p of ch.modified) info(`  ${chalk.yellow("modified")}  ${p}`);
    for (const p of ch.added) info(`  ${chalk.green("added")}     ${p}`);
    for (const p of ch.deleted) info(`  ${chalk.red("deleted")}   ${p}`);
    info(chalk.dim(`  commit them: lizard git commit -m "..."`));
  });
  return true;
}

function repoOpt(c: Command): Command {
  return c.option("-R, --repo <owner/name>", "Repository (default: the one this checkout is of)");
}

export function registerLizardGit(git: Command) {
  git.description("Lizard Git (lizard.build/git) repositories, pull requests, CI; and GitHub integration");

  // ── Working copies ───────────────────────────────────────────────────
  git
    .command("clone")
    .description("Check out a Lizard Git repository: only files, fetched on demand by hash (no history to download)")
    .argument("<repo>", "owner/name, or name for one of yours")
    .argument("[dir]", "Directory (default: the repository name)")
    .option("-b, --branch <name>", "Branch (default: the repository's default branch)")
    .option("--sparse <paths>", "Only these folders or files, comma-separated (a sparse checkout fetches nothing else)")
    .action(async (repoArg: string, dir: string | undefined, opts: { branch?: string; sparse?: string }) => {
      const repo = await resolveRepo(repoArg);
      const target = dir ?? repo.split("/")[1];
      const sparse = list(opts.sparse)?.map((x) => x.replace(/^\/+|\/+$/g, "")) ?? null;
      const c = await wc.clone(repo, target, opts.branch, sparse, (m) => !isJSONMode() && process.stderr.write(chalk.dim(`  ${m}\r`)));
      if (!isJSONMode()) process.stderr.write("\x1b[2K");
      done({ repo, dir: target, branch: c.branch, commit: c.base, files: Object.keys(c.files).length, sparse },
        `Checked out ${repo} (${c.branch} at ${c.base.slice(0, 12)}, ${Object.keys(c.files).length} files) into ${target}`);
    });

  git
    .command("init")
    .description("Make this folder the checkout of an empty repository (then lizard git commit --push)")
    .argument("<repo>", "owner/name, or name for one of yours")
    .action(async (repoArg: string) => {
      const repo = await resolveRepo(repoArg);
      const c = await wc.initHere(repo, process.cwd());
      done({ repo, branch: c.branch }, `This folder is now ${repo} (${c.branch}); commit and push with lizard git commit --push -m "..."`);
    });

  git
    .command("diff")
    .description("Your changes in this checkout against the commit it's at")
    .argument("[paths...]", "Only these files or folders")
    .option("--name-only", "Only the changed paths")
    .action(async (paths: string[], opts: { nameOnly?: boolean }) => {
      const root = needCheckout();
      const c = wc.loadCheckout(root);
      const local = wc.scanWorking(root, c);
      const ch = wc.changesOf(c, local);
      const pick = (p: string) => !paths.length || paths.some((x) => p === x || p.startsWith(x.replace(/\/+$/, "") + "/"));
      const all = [...ch.added.map((p) => ["added", p]), ...ch.modified.map((p) => ["modified", p]), ...ch.deleted.map((p) => ["deleted", p])].filter(([, p]) => pick(p));
      if (isJSONMode() || opts.nameOnly) {
        out(all.map(([status, path]) => ({ status, path })), () => all.forEach(([, p]) => console.log(p)));
        return;
      }
      const before = await wc.getBlobs(c.repo, all.filter(([k]) => k !== "added").map(([, p]) => c.files[p].h));
      for (const [kind, p] of all) {
        const old = kind === "added" ? "" : before.get(c.files[p].h)!.toString();
        const cur = kind === "deleted" ? "" : readFileSync(`${root}/${p}`, "utf8");
        if (old.includes("\0") || cur.includes("\0")) {
          console.log(chalk.bold(`Binary ${p} ${kind}`));
          continue;
        }
        if (old.length + cur.length > 4 << 20) {
          console.log(chalk.bold(`${p}: ${kind} (too large to show)`));
          continue;
        }
        for (const line of wc.unifiedDiff(old, cur, p).split("\n")) {
          console.log(line.startsWith("+") && !line.startsWith("+++") ? chalk.green(line) : line.startsWith("-") && !line.startsWith("---") ? chalk.red(line) : line.startsWith("@@") ? chalk.cyan(line) : line);
        }
      }
    });

  const pushed = (r: wc.PushResult) => {
    const extra = r.sync.updated.length + r.sync.removed.length;
    return `Pushed ${r.shas.length} commit${r.shas.length === 1 ? "" : "s"} to ${r.branch}: ${r.sha.slice(0, 12)}${r.uploaded ? chalk.dim(` (${r.uploaded} file(s) uploaded)`) : ""}${extra ? chalk.dim(` · ${extra} file(s) from others' commits updated`) : ""}`;
  };

  git
    .command("commit")
    .description("Commit your changes here (lizard git push sends them); --push sends at once")
    .argument("[paths...]", "Only these files or folders (default: every change)")
    .requiredOption("-m, --message <text>", "Commit message")
    .option("-b, --branch <name>", "Commit to a new branch, starting at this checkout's commit (and switch to it)")
    .option("--push", "Push right after committing")
    .action(async (paths: string[], opts: { message: string; branch?: string; push?: boolean }) => {
      const root = needCheckout();
      const c = wc.loadCheckout(root);
      const r = wc.commitLocal(root, c, opts.message.endsWith("\n") ? opts.message : opts.message + "\n", paths, opts.branch);
      if (opts.push) {
        const p = await wc.push(root, c);
        return done(p, pushed(p));
      }
      done(r, `Committed ${r.files} file(s) on ${r.branch} ${chalk.dim(`(${r.pending} not pushed: lizard git push)`)}`);
    });

  git
    .command("push")
    .description("Send the commits made here: the branch moves once (one CI run, one deploy); if it moved meanwhile, the server puts them on top")
    .action(async () => {
      const root = needCheckout();
      const c = wc.loadCheckout(root);
      const r = await wc.push(root, c);
      done(r, pushed(r));
    });

  git
    .command("uncommit")
    .description("Turn the commits not pushed yet back into changes in your files (e.g. to resolve a conflict)")
    .action(async () => {
      const root = needCheckout();
      const c = wc.loadCheckout(root);
      const n = wc.uncommit(root, c);
      done({ uncommitted: n, branch: c.branch }, n ? `${n} commit${n === 1 ? "" : "s"} undone; the changes are in your files (lizard git status)` : "No commits waiting to be pushed");
    });

  git
    .command("sync")
    .alias("pull")
    .description("Bring this checkout to the branch's latest commit (keeps your changes)")
    .action(async () => {
      const root = needCheckout();
      const c = wc.loadCheckout(root);
      const r = await wc.sync(root, c);
      done(r, r.from === r.to ? `Already at ${c.branch}'s latest (${r.to.slice(0, 12)})` :
        `${c.branch}: ${r.from.slice(0, 12)} -> ${r.to.slice(0, 12)} (${r.updated.length} updated, ${r.removed.length} removed)`);
    });

  git
    .command("switch")
    .description("Switch this checkout to another branch (keeps your changes)")
    .argument("<branch>")
    .option("-c, --create", "Create the branch at this checkout's commit first")
    .action(async (branch: string, opts: { create?: boolean }) => {
      const root = needCheckout();
      const c = wc.loadCheckout(root);
      wc.needNoPending(c);
      if (opts.create) await lg.post(`${repoPath(c.repo)}/branches`, { name: branch, from: c.base });
      const r = await wc.sync(root, c, branch);
      done({ ...r, branch }, `On ${branch} at ${r.to.slice(0, 12)} (${r.updated.length} updated, ${r.removed.length} removed)`);
    });

  git
    .command("sparse")
    .description("Change which folders this checkout has (comma-separated; \"all\" for everything)")
    .argument("<paths>")
    .action(async (paths: string) => {
      const root = needCheckout();
      const c = wc.loadCheckout(root);
      wc.needNoPending(c);
      const local = wc.scanWorking(root, c);
      const ch = wc.changesOf(c, local);
      if (ch.added.length + ch.modified.length + ch.deleted.length) throw new APIError(409, "commit and push your changes first (lizard git commit --push)");
      const next = paths === "all" ? null : list(paths)!.map((x) => x.replace(/^\/+|\/+$/g, ""));
      // Drop what leaves the set, then sync with the new set (fetches what joins it).
      const keep = (p: string) => !next || next.some((x) => p === x || p.startsWith(x + "/"));
      for (const p of Object.keys(c.files)) {
        if (!keep(p)) {
          wc.removeFileAt(root, p);
          delete c.files[p];
        }
      }
      c.sparse = next;
      const before = c.base;
      c.base = ""; // make sync list and fetch everything in the new set
      const r = await wc.sync(root, c);
      done({ sparse: next, files: Object.keys(c.files).length, commit: r.to }, `Sparse: ${next ? next.join(", ") : "everything"} (${Object.keys(c.files).length} files at ${(r.to || before).slice(0, 12)})`);
    });

  // ── Repositories ─────────────────────────────────────────────────────
  const repo = git.command("repo").description("Lizard Git repositories");
  repo
    .command("list")
    .alias("ls")
    .description("Your repositories and the ones you collaborate on")
    .option("--owner <login>", "Only this owner's")
    .option("--starred", "The ones you starred")
    .option("-q, --query <text>", "Search names and descriptions")
    .action(async (opts) => {
      const login = await myLogin();
      const repos = await lg.get<any[]>(qs("/api/repos", {
        owner: opts.owner, member: opts.owner || opts.starred ? undefined : login, starred: opts.starred ? login : undefined, q: opts.query,
      }));
      out(repos, () => {
        if (!repos.length) return info("No repositories. Create one: lizard git repo create <name>");
        table(["REPO", "VISIBILITY", "UPDATED", "DESCRIPTION"], repos.map((r) => [
          `${r.owner}/${r.name}`, r.private ? "private" : "public", ago(r.pushedAt ?? r.updatedAt), (r.description ?? "").slice(0, 60),
        ]));
      });
    });
  repo
    .command("create")
    .description("Create a repository")
    .argument("<name>")
    .option("--private", "Only you and collaborators can see it")
    .option("-d, --description <text>")
    .option("--readme", "Start with a README (otherwise empty)")
    .option("--default-branch <name>", "Default branch (main)")
    .action(async (name: string, opts) => {
      const r = await lg.post<{ owner: string; name: string }>("/api/repos", {
        name, private: !!opts.private, description: opts.description, readme: !!opts.readme, defaultBranch: opts.defaultBranch,
      });
      const full = `${r.owner}/${r.name}`;
      out({ ...r, url: `${gitURL()}/${full}` }, () => {
        success(`Created ${chalk.bold(full)}  ${link(`${gitURL()}/${full}`)}`);
        info(chalk.dim(`  Check out: lizard git clone ${full}    then: lizard git commit -m "..."`));
      });
    });
  repoOpt(repo.command("view").description("A repository's details").argument("[repo]"))
    .action(async (arg: string | undefined, opts) => {
      const r = await resolveRepo(arg ?? opts.repo);
      const m = await lg.get<any>(repoPath(r));
      out(m, () => {
        info(`${chalk.bold(r)}  ${m.repo.private ? "private" : "public"}  ${chalk.dim(`you: ${m.role || "reader"}`)}`);
        if (m.repo.description) info(m.repo.description);
        if (m.forkOf) info(chalk.dim(`forked from ${m.forkOf}`));
        info(`default branch ${m.repo.defaultBranch} · ${m.branches} branches · ${m.tags} tags · ${m.openIssues} open issues · ${m.openPulls} open pull requests · ${m.repo.stars} stars`);
        info(`${link(`${gitURL()}/${r}`)}\ncheck out: lizard git clone ${r}`);
      });
    });
  repoOpt(repo.command("edit").description("Change name, description, visibility or default branch").argument("[repo]"))
    .option("--name <name>")
    .option("-d, --description <text>")
    .option("--private").option("--public")
    .option("--default-branch <name>")
    .action(async (arg: string | undefined, opts) => {
      const r = await resolveRepo(arg ?? opts.repo);
      await lg.patch(repoPath(r), {
        name: opts.name, description: opts.description, defaultBranch: opts.defaultBranch,
        private: opts.private ? true : opts.public ? false : undefined,
      });
      done({ ok: true, repo: opts.name ? `${r.split("/")[0]}/${opts.name}` : r }, `Updated ${r}`);
    });
  repoOpt(repo.command("delete").description("Delete a repository").argument("[repo]"))
    .option("--yes", "Confirm")
    .action(async (arg: string | undefined, opts) => {
      const r = await resolveRepo(arg ?? opts.repo);
      if (!opts.yes) throw new APIError(400, `This deletes ${r} with its issues, pull requests, runs and releases. Run again with --yes.`);
      await lg.delete(repoPath(r));
      done({ ok: true, deleted: r }, `Deleted ${r}`);
    });
  repoOpt(repo.command("fork").description("Fork a repository into your account").argument("[repo]"))
    .option("--name <name>", "Name of the fork (default: the same)")
    .option("--clone", "Clone the fork afterwards")
    .action(async (arg: string | undefined, opts) => {
      const r = await resolveRepo(arg ?? opts.repo);
      const f = await lg.post<{ owner: string; name: string }>(`${repoPath(r)}/forks`, { name: opts.name });
      const full = `${f.owner}/${f.name}`;
      if (opts.clone) await wc.clone(full, f.name, undefined, null);
      done({ ...f, url: `${gitURL()}/${full}` }, `Forked ${r} to ${chalk.bold(full)}`);
    });
  repoOpt(repo.command("forks").description("Forks of a repository").argument("[repo]"))
    .action(async (arg: string | undefined, opts) => {
      const r = await resolveRepo(arg ?? opts.repo);
      const fs = await lg.get<any[]>(`${repoPath(r)}/forks`);
      out(fs, () => fs.length ? table(["FORK", "UPDATED"], fs.map((f) => [`${f.owner}/${f.name}`, ago(f.pushedAt ?? f.updatedAt)])) : info("No forks."));
    });
  for (const [cmd, method, msg] of [["star", "put", "Starred"], ["unstar", "delete", "Unstarred"]] as const) {
    repoOpt(repo.command(cmd).description(`${msg.replace(/ed$/, "")} a repository`).argument("[repo]"))
      .action(async (arg: string | undefined, opts) => {
        const r = await resolveRepo(arg ?? opts.repo);
        await (method === "put" ? lg.put(`${repoPath(r)}/star`) : lg.delete(`${repoPath(r)}/star`));
        done({ ok: true }, `${msg} ${r}`);
      });
  }

  // ── Branches, files, commits ─────────────────────────────────────────
  const branch = git.command("branch").description("Branches and tags of a Lizard Git repository");
  repoOpt(branch.command("list").alias("ls").description("Branches and tags"))
    .option("--tags", "Tags only")
    .action(async (opts) => {
      const r = await resolveRepo(opts.repo);
      const refs = (await lg.get<any[]>(`${repoPath(r)}/refs`)).filter((x) => (opts.tags ? x.kind === "tag" : true));
      out(refs, () => table(["NAME", "KIND", "COMMIT", "UPDATED", "SUBJECT"], refs.map((x) => [x.name, x.kind, x.sha.slice(0, 7), ago(x.date), (x.subject ?? "").slice(0, 50)])));
    });
  repoOpt(branch.command("create").description("Create a branch").argument("<name>"))
    .option("--from <ref>", "Start point (default branch)")
    .action(async (name: string, opts) => {
      const r = await resolveRepo(opts.repo);
      const b = await lg.post(`${repoPath(r)}/branches`, { name, from: opts.from });
      done(b, `Created branch ${name} at ${String(b.sha).slice(0, 7)}`);
    });
  repoOpt(branch.command("delete").description("Delete a branch").argument("<name>"))
    .action(async (name: string, opts) => {
      const r = await resolveRepo(opts.repo);
      await lg.delete(`${repoPath(r)}/branches/${segs(name)}`);
      done({ ok: true }, `Deleted branch ${name}`);
    });

  repoOpt(git.command("ls").description("List files in a Lizard Git repository").argument("[path]"))
    .option("--ref <ref>", "Branch, tag or commit")
    .option("-r, --recursive", "Every file path")
    .action(async (path: string | undefined, opts) => {
      const r = await resolveRepo(opts.repo);
      if (opts.recursive) {
        const files = await lg.get<string[]>(qs(`${repoPath(r)}/files`, { ref: opts.ref }));
        const f = path ? files.filter((p) => p.startsWith(path.replace(/\/?$/, "/"))) : files;
        return out(f, () => process.stdout.write(f.join("\n") + (f.length ? "\n" : "")));
      }
      const t = await lg.get<any>(qs(`${repoPath(r)}/tree`, { ref: opts.ref, path }));
      const entries: any[] = t.entries ?? t;
      out(t, () => table(["TYPE", "NAME", "SIZE"], entries.map((e) => [e.type, e.type === "tree" ? chalk.bold(e.name + "/") : e.name, e.size != null ? String(e.size) : ""])));
    });
  repoOpt(git.command("cat").description("Print a file from a Lizard Git repository").argument("<path>"))
    .option("--ref <ref>", "Branch, tag or commit (default branch)")
    .option("-o, --output <file>", "Write to a file instead")
    .action(async (path: string, opts) => {
      const r = await resolveRepo(opts.repo);
      const ref = opts.ref ?? (await lg.get<any>(repoPath(r))).repo.defaultBranch;
      const [o, n] = r.split("/");
      const data = await lg.bytes(`/raw/${seg(o)}/${seg(n)}/${segs(ref)}/${segs(path)}`);
      if (opts.output) {
        writeFileSync(opts.output, data);
        return done({ path, ref, bytes: data.length, output: opts.output }, `Wrote ${data.length} bytes to ${opts.output}`);
      }
      if (isJSONMode()) return printJSON({ path, ref, content: data.toString("utf8") });
      process.stdout.write(data);
    });
  repoOpt(git.command("log").description("Commits of a Lizard Git repository"))
    .option("--ref <ref>", "Branch, tag or commit")
    .option("--path <path>", "Only commits that touch this path")
    .option("--page <n>", "Page", "1")
    .action(async (opts) => {
      const r = await resolveRepo(opts.repo);
      const c = await lg.get<any>(qs(`${repoPath(r)}/commits`, { ref: opts.ref, path: opts.path, page: opts.page }));
      out(c, () => table(["COMMIT", "AUTHOR", "WHEN", "SUBJECT"], c.commits.map((x: any) => [chalk.yellow(x.sha.slice(0, 7)), x.authorName, ago(x.date), x.subject.slice(0, 70)])));
    });
  repoOpt(git.command("show").description("One commit: message and changed files").argument("<sha>"))
    .action(async (sha: string, opts) => {
      const r = await resolveRepo(opts.repo);
      const c = await lg.get<any>(`${repoPath(r)}/commits/${seg(sha)}`);
      out(c, () => {
        info(`${chalk.yellow(c.commit.sha)}\n${c.commit.authorName} <${c.commit.authorEmail}>  ${ago(c.commit.date)}\n\n  ${c.commit.subject}\n`);
        for (const f of c.diff?.files ?? []) info(`  ${f.status} ${f.newPath || f.oldPath}  ${chalk.green(`+${f.additions}`)} ${chalk.red(`-${f.deletions}`)}`);
      });
    });
  repoOpt(git.command("search").description("Search the code of a Lizard Git repository").argument("<text>"))
    .option("--ref <ref>")
    .action(async (text: string, opts) => {
      const r = await resolveRepo(opts.repo);
      const hits = await lg.get<any[]>(qs(`${repoPath(r)}/search`, { q: text, ref: opts.ref }));
      out(hits, () => hits.length ? hits.forEach((h) => info(`${chalk.cyan(h.path)}:${h.line}: ${(h.text ?? "").trim()}`)) : info("No matches."));
    });
  // ── Issues and pull requests ─────────────────────────────────────────
  for (const kind of ["issue", "pr"] as const) {
    const pulls = kind === "pr";
    const noun = pulls ? "pull request" : "issue";
    const grp = git.command(kind).description(pulls ? "Pull requests: create, review, merge" : "Issues");

    repoOpt(grp.command("list").alias("ls").description(`List ${noun}s`))
      .option("-s, --state <state>", "open, closed or all", "open")
      .option("-l, --label <name>")
      .option("-a, --assignee <login>")
      .option("-q, --query <text>")
      .action(async (opts) => {
        const r = await resolveRepo(opts.repo);
        const l = await lg.get<any>(qs(`${repoPath(r)}/issues`, { state: opts.state, label: opts.label, assignee: opts.assignee, q: opts.query, pulls: pulls ? 1 : undefined }));
        out(l, () => {
          if (!l.items.length) return info(`No ${opts.state === "all" ? "" : opts.state + " "}${noun}s. (${l.open} open, ${l.closed} closed)`);
          table(["#", "STATE", "TITLE", pulls ? "BRANCH" : "LABELS", "AUTHOR", "UPDATED"], l.items.map((i: any) => [
            String(i.number), state(i.draft ? "draft" : i.state), i.title.slice(0, 60),
            pulls ? `${i.headRepo ? i.headRepo.split("/")[0] + ":" : ""}${i.headRef} → ${i.baseRef}` : (i.labels ?? []).map((x: any) => x.name).join(","),
            i.author, ago(i.updatedAt),
          ]));
        });
      });

    const create = repoOpt(grp.command("create").description(`Open ${pulls ? "a pull request" : "an issue"}`))
      .requiredOption("-t, --title <text>")
      .option("-b, --body <text>")
      .option("-F, --body-file <file>", "Body from a file (- for stdin)");
    if (pulls) {
      create
        .option("-H, --head <branch>", "Branch with the changes (default: the current git branch); owner:branch for a fork")
        .option("-B, --base <branch>", "Branch to merge into (default branch)")
        .option("--head-repo <owner/name>", "The fork the head branch is on")
        .option("-d, --draft", "Open as a draft")
        .option("-r, --reviewer <login>", "Ask for a review; repeatable", collect, []);
    }
    create.option("-l, --label <name>", "Add a label; repeatable", collect, []).option("-a, --assignee <login>", "Assign; repeatable", collect, []);
    create.action(async (opts) => {
      const r = await resolveRepo(opts.repo);
      const body: Record<string, unknown> = { title: opts.title, body: bodyFrom(opts) ?? "" };
      if (pulls) {
        let head = opts.head;
        if (!head) {
          const root = wc.findCheckout();
          head = root ? wc.loadCheckout(root).branch : "";
          if (!head) throw new APIError(400, "pass --head <branch>");
        }
        Object.assign(body, { head, base: opts.base, headRepo: opts.headRepo, draft: !!opts.draft, reviewers: opts.reviewer.length ? opts.reviewer : undefined });
      }
      const { number } = await lg.post<{ number: number }>(`${repoPath(r)}/issues`, body);
      if (opts.label.length || opts.assignee.length) {
        await lg.patch(`${repoPath(r)}/issues/${number}`, { labels: opts.label.length ? opts.label : undefined, assignees: opts.assignee.length ? opts.assignee : undefined });
      }
      const url = `${gitURL()}/${r}/${pulls ? "pull" : "issues"}/${number}`;
      out({ number, url }, () => success(`Opened ${noun} #${number}  ${link(url)}`));
    });

    repoOpt(grp.command("view").description(`Show ${pulls ? "a pull request" : "an issue"} with its conversation`).argument("<number>", "", int))
      .option("--comments", "Show every comment (default: the last 10)")
      .action(async (n: number, opts) => {
        const r = await resolveRepo(opts.repo);
        const d = await lg.get<any>(`${repoPath(r)}/issues/${n}`);
        let reviews: any = null;
        if (d.issue.isPull) reviews = await lg.get<any>(`${repoPath(r)}/pulls/${n}/reviews`).catch(() => null);
        out(reviews ? { ...d, reviews } : d, () => {
          const i = d.issue;
          info(`${chalk.bold(i.title)} ${chalk.dim(`#${i.number}`)}  ${state(i.draft ? "draft" : i.state)}`);
          info(chalk.dim(`${i.author} opened ${ago(i.createdAt)}${i.isPull ? ` · ${i.headRepo ? i.headRepo + ":" : ""}${i.headRef} → ${i.baseRef}` : ""}`));
          if (i.labels?.length) info(`labels: ${i.labels.map((l: any) => l.name).join(", ")}`);
          if (i.assignees?.length) info(`assignees: ${i.assignees.map((a: any) => a.login).join(", ")}`);
          if (d.pull) {
            const p = d.pull;
            if (p.merge) info(`merge: ${p.merge.conflicts?.length ? chalk.red("conflicts in " + p.merge.conflicts.join(", ")) : chalk.green("no conflicts")}`);
            if (p.gate?.blockers?.length) info(`${chalk.yellow("blocked:")} ${p.gate.blockers.join("; ")}`);
            if (reviews?.decision) info(`reviews: ${reviews.decision.approvals.length} approved${reviews.decision.changesRequested.length ? `, changes requested by ${reviews.decision.changesRequested.join(", ")}` : ""}`);
          }
          if (i.body?.trim()) info(`\n${i.body.trim()}\n`);
          const cs: any[] = (d.comments ?? []).filter((c: any) => c.kind === "comment" || !c.kind);
          for (const c of opts.comments ? cs : cs.slice(-10)) info(`${chalk.bold(c.author)} ${chalk.dim(ago(c.createdAt))}\n  ${String(c.body).trim().replace(/\n/g, "\n  ")}\n`);
          info(link(`${gitURL()}/${r}/${i.isPull ? "pull" : "issues"}/${i.number}`));
        });
      });

    repoOpt(grp.command("comment").description("Add a comment").argument("<number>", "", int))
      .option("-b, --body <text>")
      .option("-F, --body-file <file>", "Body from a file (- for stdin)")
      .action(async (n: number, opts) => {
        const r = await resolveRepo(opts.repo);
        const body = bodyFrom(opts);
        if (!body?.trim()) throw new APIError(400, "pass --body or --body-file");
        const c = await lg.post(`${repoPath(r)}/issues/${n}/comments`, { body });
        done(c, `Commented on #${n}`);
      });

    const edit = repoOpt(grp.command("edit").description("Change title, body, labels, assignees" + (pulls ? ", reviewers" : "")).argument("<number>", "", int))
      .option("-t, --title <text>")
      .option("-b, --body <text>")
      .option("-F, --body-file <file>")
      .option("--add-label <names>", "Comma-separated").option("--remove-label <names>", "Comma-separated")
      .option("--add-assignee <logins>", "Comma-separated").option("--remove-assignee <logins>", "Comma-separated");
    if (pulls) edit.option("--add-reviewer <logins>", "Comma-separated").option("--remove-reviewer <logins>", "Comma-separated");
    edit.action(async (n: number, opts) => {
      const r = await resolveRepo(opts.repo);
      const d = await lg.get<any>(`${repoPath(r)}/issues/${n}`);
      const merge = (cur: string[], add?: string, remove?: string) => {
        if (!add && !remove) return undefined;
        const rm = new Set(list(remove) ?? []);
        return [...new Set([...cur, ...(list(add) ?? [])])].filter((x) => !rm.has(x));
      };
      const reviewers = pulls ? merge((d.pull?.reviewRequests ?? []).map((x: any) => x.login), opts.addReviewer, opts.removeReviewer) : undefined;
      await lg.patch(`${repoPath(r)}/issues/${n}`, {
        title: opts.title, body: bodyFrom(opts),
        labels: merge(d.issue.labels.map((l: any) => l.name), opts.addLabel, opts.removeLabel),
        assignees: merge(d.issue.assignees.map((a: any) => a.login), opts.addAssignee, opts.removeAssignee),
        reviewers,
      });
      done({ ok: true }, `Updated #${n}`);
    });

    for (const [cmd, st] of [["close", "closed"], ["reopen", "open"]] as const) {
      repoOpt(grp.command(cmd).description(`${cmd === "close" ? "Close" : "Reopen"} ${pulls ? "a pull request" : "an issue"}`).argument("<number>", "", int))
        .option("-c, --comment <text>", "Comment first")
        .action(async (n: number, opts) => {
          const r = await resolveRepo(opts.repo);
          if (opts.comment) await lg.post(`${repoPath(r)}/issues/${n}/comments`, { body: opts.comment });
          await lg.patch(`${repoPath(r)}/issues/${n}`, { state: st });
          done({ ok: true, number: n, state: st }, `${cmd === "close" ? "Closed" : "Reopened"} #${n}`);
        });
    }

    if (!pulls) continue;

    repoOpt(grp.command("ready").description("Mark a draft ready for review").argument("<number>", "", int))
      .option("--undo", "Back to draft")
      .action(async (n: number, opts) => {
        const r = await resolveRepo(opts.repo);
        await lg.patch(`${repoPath(r)}/issues/${n}`, { draft: !!opts.undo });
        done({ ok: true, draft: !!opts.undo }, opts.undo ? `#${n} is a draft again` : `#${n} is ready for review`);
      });
    repoOpt(grp.command("diff").description("The changes of a pull request").argument("<number>", "", int))
      .option("--stat", "Only the files changed")
      .action(async (n: number, opts) => {
        const r = await resolveRepo(opts.repo);
        const d = await lg.get<any>(`${repoPath(r)}/pulls/${n}/diff`);
        out(d, () => {
          for (const f of d.diff?.files ?? []) {
            const name = f.oldPath && f.newPath && f.oldPath !== f.newPath ? `${f.oldPath} → ${f.newPath}` : f.newPath || f.oldPath;
            process.stdout.write(`${chalk.bold(name)}  ${chalk.green(`+${f.additions}`)} ${chalk.red(`-${f.deletions}`)}${f.binary ? " (binary)" : ""}\n`);
            if (opts.stat) continue;
            for (const h of f.hunks ?? []) {
              process.stdout.write(chalk.cyan(h.header) + "\n");
              for (const l of h.lines ?? []) {
                const t = `${l.k}${l.t}`;
                process.stdout.write((l.k === "+" ? chalk.green(t) : l.k === "-" ? chalk.red(t) : t) + "\n");
              }
            }
          }
        });
      });
    repoOpt(grp.command("commits").description("Commits of a pull request").argument("<number>", "", int))
      .action(async (n: number, opts) => {
        const r = await resolveRepo(opts.repo);
        const cs = await lg.get<any[]>(`${repoPath(r)}/pulls/${n}/commits`);
        out(cs, () => table(["COMMIT", "AUTHOR", "SUBJECT"], cs.map((c) => [chalk.yellow(c.sha.slice(0, 7)), c.authorName, c.subject.slice(0, 70)])));
      });
    repoOpt(grp.command("review").description("Approve, request changes, or comment on a pull request").argument("<number>", "", int))
      .option("--approve").option("--request-changes").option("--comment", "A review that only comments (default)")
      .option("-b, --body <text>")
      .option("-F, --body-file <file>")
      .option("--line <path:line=text>", "A comment on a line of the new code; repeatable", collect, [])
      .action(async (n: number, opts) => {
        const r = await resolveRepo(opts.repo);
        const event = opts.approve ? "APPROVE" : opts.requestChanges ? "REQUEST_CHANGES" : "COMMENT";
        const comments = (opts.line as string[]).map((s) => {
          const m = s.match(/^(.+):(\d+)=(.*)$/s);
          if (!m) throw new APIError(400, `--line is path:line=text, got "${s}"`);
          return { path: m[1], line: Number(m[2]), side: "RIGHT", body: m[3] };
        });
        const rv = await lg.post(`${repoPath(r)}/pulls/${n}/reviews`, { event, body: bodyFrom(opts) ?? "", comments });
        done(rv, `${event === "APPROVE" ? "Approved" : event === "REQUEST_CHANGES" ? "Requested changes on" : "Reviewed"} #${n}`);
      });
    repoOpt(grp.command("reviews").description("Reviews and line comments of a pull request").argument("<number>", "", int))
      .action(async (n: number, opts) => {
        const r = await resolveRepo(opts.repo);
        const rv = await lg.get<any>(`${repoPath(r)}/pulls/${n}/reviews`);
        out(rv, () => {
          for (const x of rv.reviews) info(`${chalk.bold(x.author)} ${state(x.state)} ${chalk.dim(ago(x.createdAt))}${x.body ? `\n  ${x.body}` : ""}`);
          for (const c of rv.comments) info(`${chalk.cyan(`${c.path}:${c.line}`)} ${chalk.bold(c.author)}: ${c.body}`);
          info(`approvals: ${rv.decision.approvals.join(", ") || "none"}${rv.decision.changesRequested.length ? ` · changes requested: ${rv.decision.changesRequested.join(", ")}` : ""}`);
        });
      });
    repoOpt(grp.command("checks").description("CI runs and commit statuses of a pull request's head").argument("<number>", "", int))
      .option("-w, --watch", "Wait until every check has finished")
      .action(async (n: number, opts) => {
        const r = await resolveRepo(opts.repo);
        for (;;) {
          const d = await lg.get<any>(`${repoPath(r)}/issues/${n}`);
          const sha = d.pull?.headSha;
          if (!sha) throw new APIError(404, `#${n} has no head commit`);
          const [st, runs] = await Promise.all([
            lg.get<any>(`${repoPath(r)}/commits/${sha}/status`),
            lg.get<any>(qs(`${repoPath(r)}/actions/runs`, { sha })),
          ]);
          const pending = st.statuses.some((s: any) => s.state === "pending") || runs.runs.some((x: any) => ACTIVE_RUN.has(x.status));
          if (opts.watch && pending) {
            if (!isJSONMode()) info(chalk.dim(`waiting for ${runs.runs.filter((x: any) => ACTIVE_RUN.has(x.status)).length} run(s)...`));
            await sleep(5000);
            continue;
          }
          out({ sha, state: st.state, statuses: st.statuses, runs: runs.runs }, () => {
            info(`${chalk.yellow(sha.slice(0, 7))} ${state(st.state)}`);
            const rows = [
              ...runs.runs.map((x: any) => [state(x.status), x.name, `run #${x.number}`, ago(x.finishedAt ?? x.startedAt ?? x.createdAt)]),
              ...st.statuses.map((s: any) => [state(s.state), s.context, s.description ?? "", ago(s.createdAt)]),
            ];
            rows.length ? table(["STATE", "CHECK", "DETAIL", "WHEN"], rows) : info("No checks.");
          });
          const failed = st.state === "failure" || st.state === "error" || runs.runs.some((x: any) => x.status === "failure");
          if (failed) process.exitCode = 1;
          return;
        }
      });
    repoOpt(grp.command("merge").description("Merge a pull request").argument("<number>", "", int))
      .option("--squash").option("--rebase").option("--merge", "A merge commit (default)")
      .option("-m, --message <text>", "Commit message")
      .option("-d, --delete-branch", "Delete the head branch afterwards")
      .option("--admin", "Merge past the branch rule (admins, when the rule allows)")
      .action(async (n: number, opts) => {
        const r = await resolveRepo(opts.repo);
        const m = await lg.post<any>(`${repoPath(r)}/pulls/${n}/merge`, {
          method: opts.squash ? "squash" : opts.rebase ? "rebase" : "merge", message: opts.message, deleteBranch: !!opts.deleteBranch, bypass: !!opts.admin,
        });
        done(m, `Merged #${n} (${String(m.sha).slice(0, 7)})`);
      });
    repoOpt(grp.command("checkout").description("Switch this checkout to a pull request's branch").argument("<number>", "", int))
      .action(async (n: number, opts) => {
        const root = needCheckout();
        const c = wc.loadCheckout(root);
        const d = await lg.get<any>(`${repoPath(c.repo)}/issues/${n}`);
        // A fork's branch is read here under refs/pull/<n>/head: look, don't commit.
        const target = d.issue.headRepo && d.issue.headRepo !== c.repo ? `pull/${n}/head` : d.issue.headRef;
        const r = await wc.sync(root, c, target);
        done({ branch: target, commit: r.to }, `On ${target} (#${n}) at ${r.to.slice(0, 12)}`);
      });
  }

  // ── CI runs and workflows ────────────────────────────────────────────
  const run = git.command("run").description("CI runs (.lizard/workflows, GitHub Actions syntax)");
  repoOpt(run.command("list").alias("ls").description("Recent runs"))
    .option("-b, --branch <name>").option("--commit <sha>").option("-w, --workflow <path>").option("-s, --status <status>")
    .option("--pr <number>", "Runs of a pull request")
    .option("--page <n>", "Page", "1")
    .action(async (opts) => {
      const r = await resolveRepo(opts.repo);
      const l = await lg.get<any>(qs(`${repoPath(r)}/actions/runs`, { branch: opts.branch, sha: opts.commit, workflow: opts.workflow, status: opts.status, pr: opts.pr, page: opts.page }));
      out(l, () => l.runs.length ? table(["#", "STATUS", "WORKFLOW", "EVENT", "REF", "TITLE", "WHEN"], l.runs.map((x: any) => [
        String(x.number), state(x.status), x.name, x.event, x.ref.replace(/^refs\/(heads|tags)\//, ""), (x.title ?? "").slice(0, 40), ago(x.createdAt),
      ])) : info("No runs yet. Add a workflow under .lizard/workflows/ and push."));
    });
  repoOpt(run.command("view").description("A run with its jobs and steps").argument("<number>", "", int))
    .action(async (n: number, opts) => {
      const r = await resolveRepo(opts.repo);
      const x = await lg.get<any>(`${repoPath(r)}/actions/runs/${n}`);
      out(x, () => {
        info(`${chalk.bold(x.name)} #${x.number}  ${state(x.status)}  ${chalk.dim(`${x.event} on ${x.ref.replace(/^refs\/heads\//, "")} at ${x.sha.slice(0, 7)} by ${x.actor}`)}`);
        if (x.error) info(chalk.red(x.error));
        for (const j of x.jobs ?? []) {
          const secs = j.startedAt && j.finishedAt ? ` ${j.finishedAt - j.startedAt}s` : "";
          info(`  ${state(j.status)} ${chalk.bold(j.name)} ${chalk.dim(`job ${j.id}${secs}`)}`);
          for (const s of j.steps ?? []) info(`      ${state(s.status ?? "")} ${s.name}`);
        }
        info(link(`${gitURL()}/${r}/actions/runs/${x.number}`));
      });
    });
  repoOpt(run.command("logs").alias("log").description("A run's job logs").argument("<number>", "", int))
    .option("-j, --job <name|id>", "Only this job")
    .option("-f, --follow", "Keep printing until the run ends")
    .action(async (n: number, opts) => {
      const r = await resolveRepo(opts.repo);
      const x = await lg.get<any>(`${repoPath(r)}/actions/runs/${n}`);
      const jobs: any[] = (x.jobs ?? []).filter((j: any) => !opts.job || String(j.id) === opts.job || j.name === opts.job || j.key === opts.job);
      if (!jobs.length) throw new APIError(404, opts.job ? `no job ${opts.job} in run ${n}` : `run ${n} has no jobs`);
      const result: Record<string, string> = {};
      for (const j of jobs) {
        if (!isJSONMode() && jobs.length > 1) process.stdout.write(chalk.bold(`\n== ${j.name}\n`));
        let offset = 0, text = "";
        for (;;) {
          const c = await lg.get<any>(qs(`${repoPath(r)}/actions/jobs/${j.id}/log`, { offset }));
          if (c.text) {
            text += c.text;
            if (!isJSONMode()) process.stdout.write(c.text.replace(/^##\[lizard:(step|end)\].*\n/gm, (l: string) => (l.startsWith("##[lizard:step]") ? chalk.cyan("▸ " + l.replace(/^##\[lizard:step\] \d+ /, "")) : "")));
          }
          offset = c.next;
          if (c.done && offset >= c.size) break;
          if (!opts.follow && offset >= c.size) break;
          if (!c.text) await sleep(1500);
        }
        result[j.name] = text;
      }
      if (isJSONMode()) printJSON({ run: n, logs: result });
    });
  repoOpt(run.command("watch").description("Wait for a run to finish; exit 1 if it failed").argument("<number>", "", int))
    .option("--interval <seconds>", "", "3")
    .action(async (n: number, opts) => {
      const r = await resolveRepo(opts.repo);
      let last = "";
      for (;;) {
        const x = await lg.get<any>(`${repoPath(r)}/actions/runs/${n}`);
        const line = (x.jobs ?? []).map((j: any) => `${j.name}:${j.status}`).join(" ");
        if (!isJSONMode() && line !== last) info(`${state(x.status)} ${line}`);
        last = line;
        if (!ACTIVE_RUN.has(x.status)) {
          if (isJSONMode()) printJSON(x);
          if (x.status !== "success") process.exitCode = 1;
          return;
        }
        await sleep(Number(opts.interval) * 1000);
      }
    });
  for (const [cmd, path, msg, desc] of [
    ["cancel", "cancel", "Cancelled", "Cancel a run"],
    ["rerun", "rerun", "Started again as", "Run the same workflow at the same commit again"],
    ["approve", "approve", "Approved", "Let a run from a fork's pull request start"],
  ] as const) {
    repoOpt(run.command(cmd).description(desc).argument("<number>", "", int))
      .action(async (n: number, opts) => {
        const r = await resolveRepo(opts.repo);
        const x = await lg.post<any>(`${repoPath(r)}/actions/runs/${n}/${path}`);
        done(x, cmd === "rerun" ? `${msg} run #${x.number}` : `${msg} run #${n}`);
      });
  }
  repoOpt(run.command("artifacts").description("Artifacts a run uploaded").argument("<number>", "", int))
    .action(async (n: number, opts) => {
      const r = await resolveRepo(opts.repo);
      const a = await lg.get<any[]>(`${repoPath(r)}/actions/runs/${n}/artifacts`);
      out(a, () => a.length ? table(["NAME", "SIZE", "JOB", "WHEN"], a.map((x) => [x.name, `${x.size} B`, x.job, ago(x.createdAt)])) : info("No artifacts."));
    });
  repoOpt(run.command("download").description("Download an artifact (.tar.gz)").argument("<number>", "", int).argument("<name>"))
    .option("-o, --output <file>", "File (default: <name>.tar.gz)")
    .option("-x, --extract <dir>", "Unpack into this directory instead")
    .action(async (n: number, name: string, opts) => {
      const r = await resolveRepo(opts.repo);
      const data = await lg.bytes(`${repoPath(r)}/actions/runs/${n}/artifacts/${seg(name)}`);
      if (opts.extract) {
        // A CI job made this archive: plain files and directories only. A symlink in one
        // archive lets the next one write anywhere (GNU tar follows it on a second extract).
        const list = spawnSync("tar", ["tvzf", "-"], { input: data, encoding: "latin1" });
        if (list.status !== 0) throw new APIError(500, `not a .tar.gz: ${list.stderr}`);
        const bad = list.stdout.split("\n").filter((l) => l && !/^[-d]/.test(l));
        if (bad.length) throw new APIError(400, `the artifact has links or special files (${bad.length}); download it with -o and look first`);
        spawnSync("mkdir", ["-p", opts.extract]);
        const t = spawnSync("tar", ["xzf", "-", "--no-same-owner", "--no-same-permissions", "-C", opts.extract], { input: data });
        if (t.status !== 0) throw new APIError(500, `tar failed: ${t.stderr}`);
        return done({ name, bytes: data.length, extracted: opts.extract }, `Unpacked ${name} into ${opts.extract}`);
      }
      const file = opts.output ?? `${name}.tar.gz`;
      writeFileSync(file, data);
      done({ name, bytes: data.length, output: file }, `Saved ${name} to ${file} (${data.length} bytes)`);
    });

  const workflow = git.command("workflow").description("CI workflows of a repository");
  repoOpt(workflow.command("list").alias("ls").description("Workflows and their triggers"))
    .action(async (opts) => {
      const r = await resolveRepo(opts.repo);
      const w = await lg.get<any>(`${repoPath(r)}/actions/workflows`);
      out(w, () => {
        if (!w.enabled) warn(`CI is off for this repository: ${w.reason}`);
        w.workflows.length ? table(["WORKFLOW", "NAME", "ON", "MANUAL"], w.workflows.map((x: any) => [x.path, x.name, x.events.join(","), x.dispatch ? "yes" : ""])) : info("No workflows in .lizard/workflows/");
      });
    });
  repoOpt(workflow.command("run").description("Start a workflow that has on: workflow_dispatch").argument("<workflow>", "Path or file name, e.g. ci.yml"))
    .option("--ref <ref>", "Branch or tag (default branch)")
    .option("-f, --field <key=value>", "An input; repeatable", collect, [])
    .option("-w, --watch", "Wait for it to finish")
    .action(async (wf: string, opts) => {
      const r = await resolveRepo(opts.repo);
      const path = wf.includes("/") ? wf : `.lizard/workflows/${wf}`;
      const inputs = Object.fromEntries((opts.field as string[]).map((f) => {
        const i = f.indexOf("=");
        if (i <= 0) throw new APIError(400, `--field is key=value, got "${f}"`);
        return [f.slice(0, i), f.slice(i + 1)];
      }));
      const x = await lg.post<{ number: number }>(`${repoPath(r)}/actions/workflows/dispatch`, { workflow: path, ref: opts.ref, inputs });
      if (!opts.watch) return done(x, `Started run #${x.number}  ${link(`${gitURL()}/${r}/actions/runs/${x.number}`)}`);
      for (;;) {
        const s = await lg.get<any>(`${repoPath(r)}/actions/runs/${x.number}`);
        if (!ACTIVE_RUN.has(s.status)) {
          if (s.status !== "success") process.exitCode = 1;
          return out(s, () => info(`run #${x.number} ${state(s.status)}`));
        }
        await sleep(3000);
      }
    });

  // ── Deployments, environments, variables ─────────────────────────────
  repoOpt(run.command("deployments").description("A run's deployments to environments and what they wait for").argument("<number>", "", int))
    .action(async (n: number, opts) => {
      const r = await resolveRepo(opts.repo);
      const d = await lg.get<any>(`${repoPath(r)}/actions/runs/${n}/deployments`);
      out(d, () => d.deployments.length ? table(["ENVIRONMENT", "STATE", "REVIEWERS", "BY", "YOU CAN REVIEW"], d.deployments.map((x: any) => [
        x.environment, state(x.state === "waiting" ? "waiting" : x.state === "approved" ? "success" : x.state === "rejected" ? "failure" : "pending") + (x.state === "timer" ? " (timer)" : ""),
        (x.reviewers ?? []).join(","), x.reviewer ?? "", x.canReview ? "yes" : "",
      ])) : info("No job in this run deploys to an environment."));
    });
  repoOpt(run.command("review").description("Approve or reject a run's deployments waiting for you").argument("<number>", "", int))
    .option("--approve").option("--reject")
    .option("-e, --env <name>", "Only this environment; repeatable", collect, [])
    .option("-c, --comment <text>")
    .action(async (n: number, opts) => {
      if (!!opts.approve === !!opts.reject) throw new APIError(400, "pass --approve or --reject");
      const r = await resolveRepo(opts.repo);
      const x = await lg.post<any>(`${repoPath(r)}/actions/runs/${n}/deployments`, {
        state: opts.approve ? "approved" : "rejected", environments: opts.env.length ? opts.env : undefined, comment: opts.comment,
      });
      done(x, `${opts.approve ? "Approved" : "Rejected"} the deployment to ${x.environments.join(", ")}`);
    });

  const envc = git.command("env").alias("environment").description("Environments: who approves deployments, from which branches, their secrets and variables");
  const envPath = (r: string, name: string) => `${repoPath(r)}/actions/environments/${seg(name)}`;
  repoOpt(envc.command("list").alias("ls").description("Environments and their rules"))
    .action(async (opts) => {
      const r = await resolveRepo(opts.repo);
      const l = await lg.get<any>(`${repoPath(r)}/actions/environments`);
      out(l, () => l.environments.length ? table(["ENVIRONMENT", "REVIEWERS", "WAIT", "BRANCHES", "SECRETS", "VARIABLES"], l.environments.map((e: any) => [
        e.name, e.reviewers.join(",") + (e.preventSelfReview ? " (not self)" : ""), e.waitMinutes ? `${e.waitMinutes}m` : "",
        e.branchPolicy === "custom" ? e.branches.join(",") : e.branchPolicy, String(e.secrets.length), String(e.variables.length),
      ])) : info("No environments. A job with `environment: <name>` creates one, or: lizard git env set <name>"));
    });
  repoOpt(envc.command("view").description("One environment").argument("<name>"))
    .action(async (name: string, opts) => {
      const r = await resolveRepo(opts.repo);
      const e = await lg.get<any>(envPath(r, name));
      out(e, () => {
        info(`${chalk.bold(e.name)}`);
        info(`  reviewers: ${e.reviewers.join(", ") || "none"}${e.preventSelfReview ? " (not whoever started the run)" : ""}`);
        info(`  wait timer: ${e.waitMinutes ? e.waitMinutes + " min" : "none"}`);
        info(`  branches: ${e.branchPolicy === "custom" ? e.branches.join(", ") : e.branchPolicy}`);
        info(`  secrets: ${e.secrets.join(", ") || "none"}`);
        info(`  variables: ${e.variables.join(", ") || "none"}`);
      });
    });
  repoOpt(envc.command("set").description("Create an environment or change its protection rules").argument("<name>"))
    .option("--reviewer <login>", "Required reviewer (write access); repeatable. --reviewer '' for none", collect, [])
    .option("--prevent-self-review").option("--no-prevent-self-review")
    .option("--wait <minutes>", "Wait timer after approval")
    .option("--branches <list>", "all | protected | comma-separated branch/tag patterns (main,release/*,v*)")
    .action(async (name: string, opts) => {
      const r = await resolveRepo(opts.repo);
      const body: Record<string, unknown> = {};
      if (opts.reviewer.length) body.reviewers = (opts.reviewer as string[]).filter(Boolean);
      if (opts.preventSelfReview !== undefined) body.preventSelfReview = opts.preventSelfReview;
      if (opts.wait !== undefined) body.waitMinutes = Number(opts.wait);
      if (opts.branches !== undefined) {
        if (opts.branches === "all" || opts.branches === "protected") body.branchPolicy = opts.branches;
        else Object.assign(body, { branchPolicy: "custom", branches: list(opts.branches) ?? [] });
      }
      done(await lg.put(envPath(r, name), body), `Environment ${name} saved`);
    });
  repoOpt(envc.command("delete").alias("rm").description("Delete an environment with its secrets and variables").argument("<name>"))
    .option("--yes", "Confirm")
    .action(async (name: string, opts) => {
      if (!opts.yes) throw new APIError(400, `This deletes ${name} with its secrets and variables. Run again with --yes.`);
      const r = await resolveRepo(opts.repo);
      await lg.delete(envPath(r, name));
      done({ ok: true }, `Deleted environment ${name}`);
    });
  const envSecret = envc.command("secret").description("Environment secrets (only that environment's jobs, after its rules pass)");
  repoOpt(envSecret.command("list").alias("ls").argument("<env>"))
    .action(async (env: string, opts) => {
      const r = await resolveRepo(opts.repo);
      const l = await lg.get<any>(`${envPath(r, env)}/secrets`);
      out(l, () => l.secrets.length ? table(["NAME", "UPDATED"], l.secrets.map((x: any) => [x.name, ago(x.updatedAt)])) : info("No secrets."));
    });
  repoOpt(envSecret.command("set").argument("<env>").argument("<name>"))
    .option("-b, --body <value>", "The value (default: read from stdin)")
    .action(async (env: string, name: string, opts) => {
      const r = await resolveRepo(opts.repo);
      const value = opts.body ?? readFileSync(0, "utf8").replace(/\n$/, "");
      await lg.put(`${envPath(r, env)}/secrets/${seg(name)}`, { value });
      done({ ok: true, name }, `Set ${name} in ${env}`);
    });
  repoOpt(envSecret.command("delete").alias("rm").argument("<env>").argument("<name>"))
    .action(async (env: string, name: string, opts) => {
      const r = await resolveRepo(opts.repo);
      await lg.delete(`${envPath(r, env)}/secrets/${seg(name)}`);
      done({ ok: true }, `Deleted ${name} from ${env}`);
    });
  const varCommands = (grp: Command, base: (r: string, env?: string) => string, withEnv: boolean) => {
    const a = (c: Command) => (withEnv ? c.argument("<env>") : c);
    repoOpt(a(grp.command("list").alias("ls").description("Variables and their values")))
      .action(async (...args: any[]) => {
        const opts = args[args.length - 2];
        const r = await resolveRepo(opts.repo);
        const l = await lg.get<any>(`${base(r, withEnv ? args[0] : undefined)}/variables`);
        out(l, () => l.variables.length ? table(["NAME", "VALUE", "UPDATED"], l.variables.map((v: any) => [v.name, v.value, ago(v.updatedAt)])) : info("No variables."));
      });
    repoOpt(a(grp.command("set").description("Set a variable")).argument("<name>").argument("<value>"))
      .action(async (...args: any[]) => {
        const opts = args[args.length - 2];
        const [env, name, value] = withEnv ? args : [undefined, args[0], args[1]];
        const r = await resolveRepo(opts.repo);
        await lg.put(`${base(r, env)}/variables/${seg(name)}`, { value });
        done({ ok: true, name }, `Set ${name}`);
      });
    repoOpt(a(grp.command("delete").alias("rm").description("Delete a variable")).argument("<name>"))
      .action(async (...args: any[]) => {
        const opts = args[args.length - 2];
        const [env, name] = withEnv ? args : [undefined, args[0]];
        const r = await resolveRepo(opts.repo);
        await lg.delete(`${base(r, env)}/variables/${seg(name)}`);
        done({ ok: true }, `Deleted ${name}`);
      });
  };
  varCommands(envc.command("var").description("Environment variables (vars.NAME in its jobs)"), (r, env) => envPath(r, env!), true);
  varCommands(git.command("variable").alias("var").description("Repository variables: vars.NAME in every job"), (r) => `${repoPath(r)}/actions`, false);

  // ── Secrets ──────────────────────────────────────────────────────────
  const secret = git.command("secret").description("CI secrets of a repository (${{ secrets.NAME }})");
  repoOpt(secret.command("list").alias("ls").description("Secret names (values are never shown)"))
    .action(async (opts) => {
      const r = await resolveRepo(opts.repo);
      const s = await lg.get<any>(`${repoPath(r)}/actions/secrets`);
      out(s, () => s.secrets.length ? table(["NAME", "UPDATED"], s.secrets.map((x: any) => [x.name, ago(x.updatedAt)])) : info("No secrets."));
    });
  repoOpt(secret.command("set").description("Set a secret").argument("<name>"))
    .option("-b, --body <value>", "The value (default: read from stdin)")
    .action(async (name: string, opts) => {
      const r = await resolveRepo(opts.repo);
      const value = opts.body ?? readFileSync(0, "utf8").replace(/\n$/, "");
      await lg.put(`${repoPath(r)}/actions/secrets/${seg(name)}`, { value });
      done({ ok: true, name }, `Set secret ${name}`);
    });
  repoOpt(secret.command("delete").alias("rm").description("Delete a secret").argument("<name>"))
    .action(async (name: string, opts) => {
      const r = await resolveRepo(opts.repo);
      await lg.delete(`${repoPath(r)}/actions/secrets/${seg(name)}`);
      done({ ok: true, name }, `Deleted secret ${name}`);
    });

  // ── Collaborators and invitations ────────────────────────────────────
  const collab = git.command("collaborator").alias("collab").description("People with access to a repository");
  repoOpt(collab.command("list").alias("ls").description("Collaborators and pending invitations"))
    .action(async (opts) => {
      const r = await resolveRepo(opts.repo);
      const c = await lg.get<any>(`${repoPath(r)}/collaborators`);
      out(c, () => {
        c.collaborators.length ? table(["LOGIN", "ROLE", "SINCE"], c.collaborators.map((x: any) => [x.login, x.role, ago(x.createdAt)])) : info("No collaborators.");
        if (c.invitations?.length) {
          info("\nInvited:");
          table(["ID", "LOGIN", "ROLE", "BY"], c.invitations.map((x: any) => [String(x.id), x.login, x.role, x.inviter]));
        }
      });
    });
  repoOpt(collab.command("add").description("Invite someone (they sign in to Lizard Git once first)").argument("<login>"))
    .option("--role <role>", "read, write or admin", "write")
    .action(async (login: string, opts) => {
      const r = await resolveRepo(opts.repo);
      const x = await lg.post<any>(`${repoPath(r)}/collaborators`, { login, role: opts.role });
      done(x, x.status === "updated" ? `${login} is now ${opts.role}` : `Invited ${login} as ${opts.role}; they're in once they accept`);
    });
  repoOpt(collab.command("role").description("Change someone's role").argument("<login>").argument("<role>", "read, write or admin"))
    .action(async (login: string, role: string, opts) => {
      const r = await resolveRepo(opts.repo);
      done(await lg.patch(`${repoPath(r)}/collaborators/${seg(login)}`, { role }), `${login} is now ${role}`);
    });
  repoOpt(collab.command("remove").alias("rm").description("Remove someone (your own login: leave)").argument("<login>"))
    .action(async (login: string, opts) => {
      const r = await resolveRepo(opts.repo);
      await lg.delete(`${repoPath(r)}/collaborators/${seg(login)}`);
      done({ ok: true }, `Removed ${login} from ${r}`);
    });
  const inv = git.command("invitation").alias("invite").description("Repository invitations");
  inv.command("list").alias("ls").description("Invitations waiting for you")
    .action(async () => {
      const l = await lg.get<any[]>("/api/user/invitations");
      out(l, () => l.length ? table(["ID", "REPO", "ROLE", "FROM", "EXPIRES"], l.map((x) => [String(x.id), `${x.owner}/${x.repo}`, x.role, x.inviter, ago(x.expiresAt).replace(" ago", "")])) : info("No invitations."));
    });
  for (const answer of ["accept", "decline"] as const) {
    inv.command(answer).description(`${answer === "accept" ? "Accept" : "Decline"} an invitation`).argument("<id>", "", int)
      .action(async (id: number) => {
        await lg.post(`/api/user/invitations/${id}/${answer}`);
        done({ ok: true }, `${answer === "accept" ? "Accepted" : "Declined"} invitation ${id}`);
      });
  }
  repoOpt(inv.command("cancel").description("Withdraw an invitation you sent").argument("<id>", "", int))
    .action(async (id: number, opts) => {
      const r = await resolveRepo(opts.repo);
      await lg.delete(`${repoPath(r)}/invitations/${id}`);
      done({ ok: true }, `Cancelled invitation ${id}`);
    });

  // ── Webhooks ─────────────────────────────────────────────────────────
  const hook = git.command("webhook").alias("hook").description("Webhooks (GitHub-style payloads, X-Hub-Signature-256)");
  repoOpt(hook.command("list").alias("ls").description("Webhooks of a repository"))
    .action(async (opts) => {
      const r = await resolveRepo(opts.repo);
      const h = await lg.get<any>(`${repoPath(r)}/hooks`);
      out(h, () => h.hooks.length ? table(["ID", "URL", "EVENTS", "ACTIVE", "LAST"], h.hooks.map((x: any) => [String(x.id), x.url, x.events.join(","), x.active ? "yes" : "no", x.lastStatus ? String(x.lastStatus) : x.lastError ?? ""])) : info(`No webhooks. Events: ${h.events.join(", ")}`));
    });
  const hookFields = (c: Command) => c
    .option("-e, --events <list>", "Comma-separated events (default push), or *")
    .option("--secret <secret>", "Signs each delivery (X-Hub-Signature-256)")
    .option("--content-type <type>", "json or form")
    .option("--inactive", "Don't deliver for now").option("--active");
  hookFields(repoOpt(hook.command("create").description("Add a webhook").argument("<url>")))
    .action(async (url: string, opts) => {
      const r = await resolveRepo(opts.repo);
      const h = await lg.post<any>(`${repoPath(r)}/hooks`, { url, events: list(opts.events), secret: opts.secret, contentType: opts.contentType, active: !opts.inactive });
      done(h, `Added webhook ${h.id} (${h.events.join(", ")})`);
    });
  hookFields(repoOpt(hook.command("edit").description("Change a webhook").argument("<id>", "", int)))
    .option("--url <url>")
    .action(async (id: number, opts) => {
      const r = await resolveRepo(opts.repo);
      done(await lg.patch(`${repoPath(r)}/hooks/${id}`, {
        url: opts.url, events: list(opts.events), secret: opts.secret, contentType: opts.contentType, active: opts.inactive ? false : opts.active ? true : undefined,
      }), `Updated webhook ${id}`);
    });
  repoOpt(hook.command("delete").alias("rm").description("Delete a webhook").argument("<id>", "", int))
    .action(async (id: number, opts) => {
      const r = await resolveRepo(opts.repo);
      await lg.delete(`${repoPath(r)}/hooks/${id}`);
      done({ ok: true }, `Deleted webhook ${id}`);
    });
  repoOpt(hook.command("ping").description("Send a ping delivery").argument("<id>", "", int))
    .action(async (id: number, opts) => {
      const r = await resolveRepo(opts.repo);
      await lg.post(`${repoPath(r)}/hooks/${id}/pings`);
      done({ ok: true }, `Ping queued; see: lizard git webhook deliveries ${id}`);
    });
  repoOpt(hook.command("deliveries").description("Recent deliveries of a webhook").argument("<id>", "", int))
    .option("--show <delivery>", "One delivery with its request and response")
    .action(async (id: number, opts) => {
      const r = await resolveRepo(opts.repo);
      if (opts.show) {
        const d = await lg.get<any>(`${repoPath(r)}/hooks/${id}/deliveries/${seg(opts.show)}`);
        return out(d, () => info(JSON.stringify(d, null, 2)));
      }
      const l = await lg.get<any[]>(`${repoPath(r)}/hooks/${id}/deliveries`);
      out(l, () => l.length ? table(["ID", "EVENT", "STATUS", "MS", "WHEN"], l.map((x) => [String(x.id), x.event, x.status ? String(x.status) : chalk.red(x.error ?? "failed"), String(x.durationMs ?? ""), ago(x.createdAt)])) : info("No deliveries yet."));
    });
  repoOpt(hook.command("redeliver").description("Send a delivery again").argument("<id>", "", int).argument("<delivery>", "", int))
    .action(async (id: number, delivery: number, opts) => {
      const r = await resolveRepo(opts.repo);
      await lg.post(`${repoPath(r)}/hooks/${id}/deliveries/${delivery}/redeliver`);
      done({ ok: true }, `Redelivery of ${delivery} queued`);
    });

  // ── Branch protection ────────────────────────────────────────────────
  const protect = git.command("protect").description("Branch rules: required reviews and checks, no force pushes");
  repoOpt(protect.command("list").alias("ls").description("Branch rules"))
    .action(async (opts) => {
      const r = await resolveRepo(opts.repo);
      const l = await lg.get<any[]>(`${repoPath(r)}/branch-rules`);
      out(l, () => l.length ? table(["ID", "BRANCHES", "PR", "APPROVALS", "CHECKS", "NO FORCE", "NO DELETE", "ADMINS TOO", "CODEOWNERS"], l.map((x) => [
        String(x.id), x.pattern, x.requirePullRequest ? "yes" : "", String(x.requiredApprovals || ""), x.requiredChecks.join(","),
        x.blockForcePush ? "yes" : "", x.blockDeletion ? "yes" : "", x.enforceAdmins ? "yes" : "", x.requireCodeOwners ? "yes" : "",
      ])) : info("No branch rules."));
    });
  repoOpt(protect.command("set").description("Create or change the rule for a branch pattern").argument("<pattern>", "Branch name or glob, e.g. main or release/*"))
    .option("--require-pr", "Changes only through pull requests").option("--no-require-pr")
    .option("--approvals <n>", "Approving reviews required")
    .option("--checks <list>", "Comma-separated status checks that must pass (\"\" for none)")
    .option("--block-force-push").option("--no-block-force-push")
    .option("--block-deletion").option("--no-block-deletion")
    .option("--enforce-admins", "Admins too").option("--no-enforce-admins")
    .option("--code-owners", "Owners in CODEOWNERS must approve").option("--no-code-owners")
    .action(async (pattern: string, opts) => {
      const r = await resolveRepo(opts.repo);
      const body = {
        pattern,
        requirePullRequest: opts.requirePr,
        requiredApprovals: opts.approvals !== undefined ? Number(opts.approvals) : undefined,
        requiredChecks: opts.checks !== undefined ? list(opts.checks) ?? [] : undefined,
        blockForcePush: opts.blockForcePush,
        blockDeletion: opts.blockDeletion,
        enforceAdmins: opts.enforceAdmins,
        requireCodeOwners: opts.codeOwners,
      };
      const existing = (await lg.get<any[]>(`${repoPath(r)}/branch-rules`)).find((x) => x.pattern === pattern);
      const rule = existing ? await lg.patch(`${repoPath(r)}/branch-rules/${existing.id}`, body) : await lg.post(`${repoPath(r)}/branch-rules`, body);
      done(rule, `${existing ? "Updated" : "Created"} the rule for ${pattern}`);
    });
  repoOpt(protect.command("delete").alias("rm").description("Remove the rule for a branch pattern").argument("<pattern>"))
    .action(async (pattern: string, opts) => {
      const r = await resolveRepo(opts.repo);
      const rule = (await lg.get<any[]>(`${repoPath(r)}/branch-rules`)).find((x) => x.pattern === pattern || String(x.id) === pattern);
      if (!rule) throw new APIError(404, `no rule for ${pattern}`);
      await lg.delete(`${repoPath(r)}/branch-rules/${rule.id}`);
      done({ ok: true }, `Removed the rule for ${rule.pattern}`);
    });

  // ── Labels ───────────────────────────────────────────────────────────
  const label = git.command("label").description("Issue and pull request labels");
  repoOpt(label.command("list").alias("ls").description("Labels"))
    .action(async (opts) => {
      const r = await resolveRepo(opts.repo);
      const l = await lg.get<any[]>(`${repoPath(r)}/labels`);
      out(l, () => table(["NAME", "COLOR", "DESCRIPTION"], l.map((x) => [chalk.hex(`#${x.color}`)("● ") + x.name, x.color, x.description])));
    });
  repoOpt(label.command("create").description("Create a label").argument("<name>"))
    .option("-c, --color <hex>", "e.g. d73a4a").option("-d, --description <text>")
    .action(async (name: string, opts) => {
      const r = await resolveRepo(opts.repo);
      done(await lg.post(`${repoPath(r)}/labels`, { name, color: opts.color?.replace(/^#/, ""), description: opts.description }), `Created label ${name}`);
    });
  repoOpt(label.command("edit").description("Change a label").argument("<name>"))
    .option("--name <new>").option("-c, --color <hex>").option("-d, --description <text>")
    .action(async (name: string, opts) => {
      const r = await resolveRepo(opts.repo);
      done(await lg.patch(`${repoPath(r)}/labels/${seg(name)}`, { name: opts.name, color: opts.color?.replace(/^#/, ""), description: opts.description }), `Updated label ${name}`);
    });
  repoOpt(label.command("delete").alias("rm").description("Delete a label").argument("<name>"))
    .action(async (name: string, opts) => {
      const r = await resolveRepo(opts.repo);
      await lg.delete(`${repoPath(r)}/labels/${seg(name)}`);
      done({ ok: true }, `Deleted label ${name}`);
    });

  // ── Releases ─────────────────────────────────────────────────────────
  const release = git.command("release").description("Releases and their files");
  const findRelease = async (r: string, tag: string) => lg.get<any>(`${repoPath(r)}/releases/tags/${seg(tag)}`);
  repoOpt(release.command("list").alias("ls").description("Releases"))
    .action(async (opts) => {
      const r = await resolveRepo(opts.repo);
      const l = await lg.get<any[]>(`${repoPath(r)}/releases`);
      out(l, () => l.length ? table(["TAG", "NAME", "KIND", "FILES", "WHEN"], l.map((x) => [x.tag, x.name, x.draft ? "draft" : x.prerelease ? "pre-release" : "", String(x.assets?.length ?? 0), ago(x.publishedAt ?? x.createdAt)])) : info("No releases."));
    });
  repoOpt(release.command("create").description("Create a release (and its tag, if new)").argument("<tag>"))
    .option("--target <ref>", "Where a new tag points (default branch)")
    .option("-t, --title <text>").option("-n, --notes <text>").option("-F, --notes-file <file>")
    .option("--draft").option("--prerelease")
    .option("-a, --asset <file>", "Attach a file; repeatable", collect, [])
    .action(async (tag: string, opts) => {
      const r = await resolveRepo(opts.repo);
      const rel = await lg.post<any>(`${repoPath(r)}/releases`, {
        tag, target: opts.target, name: opts.title ?? tag, body: opts.notesFile ? readFileSync(opts.notesFile, "utf8") : opts.notes ?? "", draft: !!opts.draft, prerelease: !!opts.prerelease,
      });
      for (const f of opts.asset as string[]) await lg.upload(qs(`${repoPath(r)}/releases/${rel.id}/assets`, { name: basename(f) }), readFileSync(f), "application/octet-stream");
      done(rel, `Created release ${tag}${opts.asset.length ? ` with ${opts.asset.length} file(s)` : ""}  ${link(`${gitURL()}/${r}/releases/tag/${tag}`)}`);
    });
  repoOpt(release.command("view").description("A release and its files").argument("<tag>"))
    .action(async (tag: string, opts) => {
      const r = await resolveRepo(opts.repo);
      const x = await findRelease(r, tag);
      out(x, () => {
        info(`${chalk.bold(x.name || x.tag)} ${chalk.dim(x.tag)}${x.draft ? " draft" : ""}${x.prerelease ? " pre-release" : ""}  ${x.sha?.slice(0, 7) ?? ""}`);
        if (x.body) info(`\n${x.body}\n`);
        for (const a of x.assets ?? []) info(`  ${a.name}  ${a.size} B`);
      });
    });
  repoOpt(release.command("edit").description("Change a release").argument("<tag>"))
    .option("-t, --title <text>").option("-n, --notes <text>")
    .option("--draft").option("--no-draft").option("--prerelease").option("--no-prerelease")
    .action(async (tag: string, opts) => {
      const r = await resolveRepo(opts.repo);
      const x = await findRelease(r, tag);
      done(await lg.patch(`${repoPath(r)}/releases/${x.id}`, { name: opts.title, body: opts.notes, draft: opts.draft, prerelease: opts.prerelease }), `Updated release ${tag}`);
    });
  repoOpt(release.command("delete").alias("rm").description("Delete a release (the tag stays)").argument("<tag>"))
    .action(async (tag: string, opts) => {
      const r = await resolveRepo(opts.repo);
      const x = await findRelease(r, tag);
      await lg.delete(`${repoPath(r)}/releases/${x.id}`);
      done({ ok: true }, `Deleted release ${tag}`);
    });
  repoOpt(release.command("upload").description("Attach files to a release").argument("<tag>").argument("<files...>"))
    .action(async (tag: string, files: string[], opts) => {
      const r = await resolveRepo(opts.repo);
      const x = await findRelease(r, tag);
      const up = [];
      for (const f of files) up.push(await lg.upload(qs(`${repoPath(r)}/releases/${x.id}/assets`, { name: basename(f) }), readFileSync(f), "application/octet-stream"));
      done(up, `Uploaded ${files.length} file(s) to ${tag}`);
    });
  repoOpt(release.command("download").description("Download a release's files").argument("<tag>"))
    .option("-p, --pattern <name>", "Only this file")
    .option("-D, --dir <dir>", "Directory", ".")
    .action(async (tag: string, opts) => {
      const r = await resolveRepo(opts.repo);
      const x = await findRelease(r, tag);
      const got = [];
      for (const a of (x.assets ?? []).filter((a: any) => !opts.pattern || a.name === opts.pattern)) {
        const data = await lg.bytes(`${repoPath(r)}/releases/${x.id}/assets/${a.id}`);
        const file = basename(String(a.name)); // a name from the server never leaves the directory
        if (!file || file === "." || file === "..") continue;
        writeFileSync(`${opts.dir}/${file}`, data);
        got.push({ name: a.name, bytes: data.length });
      }
      done(got, `Downloaded ${got.length} file(s)`);
    });
  repoOpt(release.command("delete-asset").description("Remove a file from a release").argument("<tag>").argument("<name>"))
    .action(async (tag: string, name: string, opts) => {
      const r = await resolveRepo(opts.repo);
      const x = await findRelease(r, tag);
      const a = (x.assets ?? []).find((a: any) => a.name === name);
      if (!a) throw new APIError(404, `${tag} has no file ${name}`);
      await lg.delete(`${repoPath(r)}/releases/${x.id}/assets/${a.id}`);
      done({ ok: true }, `Removed ${name} from ${tag}`);
    });

  // ── Commit statuses ──────────────────────────────────────────────────
  const cs = git.command("commit-status").description("Commit statuses (external checks; what branch rules can require)");
  repoOpt(cs.command("list").alias("ls").description("Statuses of a commit or branch").argument("[ref]", "Commit, branch or tag (default branch)"))
    .action(async (ref: string | undefined, opts) => {
      const r = await resolveRepo(opts.repo);
      const x = await lg.get<any>(`${repoPath(r)}/commits/${seg(ref ?? (await lg.get<any>(repoPath(r))).repo.defaultBranch)}/status`);
      out(x, () => {
        info(`${x.sha.slice(0, 7)} ${state(x.state)}`);
        if (x.statuses.length) table(["STATE", "CONTEXT", "DESCRIPTION", "WHEN"], x.statuses.map((s: any) => [state(s.state), s.context, s.description ?? "", ago(s.createdAt)]));
      });
    });
  repoOpt(cs.command("set").description("Report a status on a commit").argument("<sha>"))
    .requiredOption("-s, --state <state>", "pending, success, failure or error")
    .requiredOption("-c, --context <name>", "e.g. ci/tests")
    .option("-d, --description <text>").option("-u, --target-url <url>")
    .action(async (sha: string, opts) => {
      const r = await resolveRepo(opts.repo);
      done(await lg.post(`${repoPath(r)}/statuses/${seg(sha)}`, { state: opts.state, context: opts.context, description: opts.description, target_url: opts.targetUrl }),
        `${opts.context}: ${opts.state} on ${sha.slice(0, 7)}`);
    });

  // ── Notifications, tokens, whoami ────────────────────────────────────
  const notif = git.command("notification").alias("inbox").description("Your Lizard Git notifications");
  notif.command("list").alias("ls").description("Unread notifications (--all for everything)")
    .option("--all")
    .action(async (opts) => {
      const n = await lg.get<any>(qs("/api/notifications", { all: opts.all ? 1 : undefined }));
      out(n, () => n.notifications.length ? table(["ID", "", "REPO", "#", "TITLE", "WHY", "WHEN"], n.notifications.map((x: any) => [
        String(x.id), x.unread ? chalk.cyan("●") : "", x.repo, x.number ? String(x.number) : "", (x.title ?? "").slice(0, 50), x.reason, ago(x.updatedAt),
      ])) : info("Nothing new."));
    });
  notif.command("read").description("Mark notifications read (all, or the ids given)").argument("[ids...]")
    .action(async (ids: string[]) => {
      await lg.post("/api/notifications/read", ids.length ? { ids: ids.map(Number) } : { all: true });
      done({ ok: true }, ids.length ? `Marked ${ids.length} read` : "Marked all read");
    });

  const token = git.command("token").description("Lizard Git tokens (lzg_...): limited to repos, refs, paths, or read-only");
  token.command("list").alias("ls").description("Your tokens")
    .action(async () => {
      const l = await lg.get<any[]>("/api/user/tokens");
      out(l, () => l.length ? table(["ID", "NAME", "REPOS", "REFS", "PATHS", "READ-ONLY", "LAST USED"], l.map((x) => [
        String(x.id), x.name, (x.scope?.repos ?? []).join(",") || "all", (x.scope?.refs ?? []).join(",") || "all", (x.scope?.paths ?? []).join(",") || "all", x.scope?.readOnly ? "yes" : "", ago(x.lastUsedAt),
      ])) : info("No tokens."));
    });
  token.command("create").description("Make a token (shown once)").argument("<name>")
    .option("--repo <owner/name>", "Only this repository; repeatable", collect, [])
    .option("--ref <pattern>", "Only these branches/tags (refs/heads/x, globs); repeatable", collect, [])
    .option("--path <prefix>", "Only these paths; repeatable", collect, [])
    .option("--read-only")
    .action(async (name: string, opts) => {
      const t = await lg.post<any>("/api/user/tokens", { name, repos: opts.repo, refs: opts.ref, paths: opts.path, readOnly: !!opts.readOnly });
      out(t, () => {
        success(`Created token ${name}`);
        process.stdout.write(t.token + "\n");
        info(chalk.dim("  Shown once. Use it as the git password, or LIZARD_GIT_TOKEN for this CLI."));
      });
    });
  token.command("delete").alias("rm").description("Revoke a token").argument("<id>", "", int)
    .action(async (id: number) => {
      await lg.delete(`/api/user/tokens/${id}`);
      done({ ok: true }, `Revoked token ${id}`);
    });

  git.command("whoami").description("Who you are on Lizard Git")
    .action(async () => {
      const u = await lg.get<any>("/api/session");
      out(u, () => info(`${chalk.bold(u.login)} on ${gitURL()}${process.env.LIZARD_GIT_TOKEN ? " (LIZARD_GIT_TOKEN)" : ""}`));
    });
}
