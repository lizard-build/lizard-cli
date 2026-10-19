import chalk from "chalk";
import ora from "ora";
import fs from "node:fs";
import * as https from "node:https";
import * as http from "node:http";
import * as p from "@clack/prompts";
import { Command, Option } from "commander";
import open from "open";
import { api, APIError, getBaseURL, getRawBytes, apiErrorFrom, clientHeaders, getRequestToken, withQuery, withScope, type ResourceScope } from "../lib/api.js";
import { getToken } from "../lib/auth.js";
import { resolveProjectScope } from "../lib/resolve.js";
import { getProjectLink, resolveProjectId, looksLikeId } from "../lib/config.js";
import { resolveVolume } from "../lib/volume.js";
import { sandboxShell } from "./sandbox-ssh.js";
import { startVncTunnel, vncTarget } from "./sandbox-vnc.js";
import { registerSandboxAgentCommands } from "./agents.js";
import { success, info, error, isJSONMode, printJSON, table, statusColor, timeAgo, isTTY } from "../lib/format.js";

// Templates are per-region rows in sandbox_templates, not a constant. Hardcoding them
// here meant a template that was built, registered and sitting warm in every region was
// still rejected before a request was ever sent — codex and interpreter both were. The
// server validates against the region's actual list and answers with what IS available,
// so let it.
const TEMPLATE_HINT = "base, interpreter, codex, claude, opencode, pi, prime, desktop";

// The three machines a sandbox can be, each priced per hour, billed per second by the server. The
// platform rejects anything else, so the CLI offers exactly these.
const SANDBOX_SIZES = ["small", "medium", "large"] as const;
const SIZE_HINT = "small 2 vCPU/4 GB, medium 4/8, large 8/16";

interface SandboxRecord {
  sandboxId: string;
  id: string;
  template: string;
  status: string;
  region: string;
  cpus: number;
  memoryMb: number;
  /** null for sandboxes from a saved snapshot, or from before sizes existed. */
  size?: string | null;
  /** Flat USD/hour; null when the sandbox is billed by measured usage. */
  pricePerHour?: number | null;
  guestIp?: string;
  startedAt: number | string;
  endAt?: number | string;
  expiresAt?: number | string;
  projectId?: string | null;
  /** Set by the platform when nothing named a project and it used the account's default. */
  projectName?: string;
  projectDefaulted?: boolean;
}

function parseIntOption(v: string): number {
  const n = Number(v);
  if (!/^\d+$/.test(v) || !Number.isSafeInteger(n) || n < 1 || n > 65535) {
    throw new Error("Port must be an integer between 1 and 65535");
  }
  return n;
}

function parseTimeoutOption(value: string): number {
  const timeout = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(timeout) || timeout > 2_147_483_647) {
    throw new Error("Timeout must be an integer from 0 to 2147483647 milliseconds");
  }
  return timeout;
}

/**
 * When the sandbox goes away. The platform deletes it, files and all, once its
 * lifetime runs out, and the default is five minutes, so say it up front.
 */
export function lifetimeLine(expiresAt: number | string | null | undefined, now = Date.now()): string {
  if (expiresAt == null) return "Lifetime: no limit. It runs until you delete it.";
  const at = new Date(expiresAt);
  if (Number.isNaN(at.getTime())) return "Lifetime: no limit. It runs until you delete it.";
  const minutes = Math.max(0, Math.round((at.getTime() - now) / 60_000));
  const left = minutes < 60 ? `${minutes} min` : `${Math.round(minutes / 6) / 10} h`;
  const clock = at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return `Lifetime: ${left}, then it is deleted with its files (at ${clock})`;
}

/** What to do with a sandbox you just made, as aligned lines with its id filled in. */
export function sandboxNextSteps(id: string): string {
  const rows: Array<[string, string]> = [
    [`lizard sandbox ssh ${id}`, "Open a shell in it"],
    [`lizard sandbox exec ${id} -- uname -a`, "Run a command"],
    [`lizard sandbox expose ${id} 3000`, "HTTPS URL for port 3000"],
    [`lizard sandbox timeout ${id} 3600000`, "Keep it for an hour"],
    [`lizard sandbox rm ${id}`, "Delete it now"],
  ];
  const width = Math.max(...rows.map(([cmd]) => cmd.length)) + 3;
  return [chalk.bold("Next"), ...rows.map(([cmd, why]) => `  ${chalk.cyan(cmd)}${" ".repeat(width - cmd.length)}${chalk.dim(why)}`)].join("\n");
}

function printSandboxList(sandboxes: SandboxRecord[]) {
  if (isJSONMode()) {
    printJSON(sandboxes);
    return;
  }
  if (sandboxes.length === 0) {
    console.log("No sandboxes. Use `lizard sandbox create`.");
    return;
  }
  table(
    ["ID", "Template", "Status", "Region", "Size", "CPU/Mem", "Created"],
    sandboxes.map((s) => [
      s.id,
      s.template,
      statusColor(s.status),
      s.region,
      s.size ?? "-",
      `${s.cpus} vCPU / ${s.memoryMb} MB`,
      timeAgo(s.startedAt as any),
    ]),
  );
}

export function registerSandbox(program: Command) {
  const sb = program
    .command("sandbox")
    .alias("sb")
    .description("Manage ephemeral compute sandboxes");

  sb.command("create")
    .description("Create a sandbox")
    .option("-t, --template <name>", `Template (${TEMPLATE_HINT}; server validates)`, "base")
    .addOption(new Option("-s, --size <size>", `Machine size (${SIZE_HINT}); default medium`).choices(SANDBOX_SIZES))
    .option("--timeout <ms>", "Lifetime in milliseconds; 0 disables expiration", parseTimeoutOption, 300_000)
    .option("--region <code>", "Region to create the sandbox in")
    .option("--snapshot <id>", "Create from a private saved snapshot, at the size it was taken at")
    .option("--volume <name-or-id>", "Attach a persistent volume")
    .option("--with-token [key]", "Sign in `lizard` inside the sandbox with a new key limited to the sandbox's project and deleted with it (this liz_ key, or the one you use, only authorizes the request)")
    .option("-p, --project <id>", "Project to create the sandbox in (name, slug, or ID). Defaults to the linked project.")
    .action(async (opts) => {
      // A snapshot restores at its source's size (a Firecracker VM's memory is part of it; a
      // pod snapshot goes back onto the machine it was captured on), so the server ignores a
      // size alongside it. Say so rather than quietly creating something other than asked.
      if (opts.size && opts.snapshot) {
        throw new Error("--size can't be combined with --snapshot: a snapshot restores at the size it was taken at.");
      }

      // A sandbox must belong to a project — billing is metered per project.
      // resolveProjectScope throws a clear "No project linked…" error when
      // there's no --project and the cwd isn't linked, so the CLI can never
      // create a project-less sandbox.
      // Deliberately NOT resolveProjectScope: that fetches the project purely to learn
      // its workspaceId, which the create endpoint looks up itself anyway, overlapped
      // with auth so it costs the server nothing. Sending it bought nothing and cost the
      // client a round trip — 113ms of a 1083ms create measured from EU.
      //
      // Unlinked and no --project: send no project, and the platform puts the sandbox in
      // the account's default project. Asking for that project first would cost every
      // such create a round trip. A volume name is only unique within a project, so
      // --volume still resolves one here.
      const named = Boolean(opts.project || getProjectLink()?.projectId || opts.volume);
      const projectId = named ? await resolveProjectId(opts.project) : undefined;
      const scope = { workspaceId: null };

      // Hand the volume to the create call instead of resolving it first.
      //
      // resolveVolume costs a full round trip purely to turn a name into an id, and the
      // create endpoint already accepts `volumeName` alongside `projectId` (LIZARD-161)
      // and resolves it in a query it was running anyway. Measured against us-east-1:
      // `sandbox create --volume` issued two requests, the resolve costing 99ms of them,
      // and ~190ms from the EU where every round trip crosses the Atlantic.
      //
      // Same id-shape fast path as resolveProjectId. A volume deliberately NAMED like a
      // nanoid would be sent as an id and 404, so that case falls back to the old resolve
      // rather than failing — wrong guesses cost a round trip, never a wrong answer.
      let volumeId: string | undefined;
      let volumeName: string | undefined;
      if (opts.volume) {
        if (looksLikeId(opts.volume)) volumeId = opts.volume;
        else volumeName = opts.volume;
      }

      const spinner = isJSONMode() ? null : ora("Creating sandbox...").start();
      let sandbox: SandboxRecord;
      try {
        // --with-token seeds ~/.lizard/config.json inside the sandbox, so `lizard` works
        // there. Bare --with-token reuses the key this command is authenticating with.
        //
        // Anything in the sandbox can read that key and sandboxes run untrusted code, so
        // a full-access key here hands the sandbox your whole account. Scopes are
        // enforced end to end now, so a workspace-scoped key is bounded to that one
        // workspace if it escapes — warn rather than silently do the dangerous thing.
        let lizardToken: string | undefined;
        if (opts.withToken) {
          lizardToken = typeof opts.withToken === "string" ? opts.withToken : (getToken() ?? undefined);
          if (!lizardToken) throw new Error("--with-token: no API key available. Pass one explicitly, or `lizard login` first.");
          if (!lizardToken.startsWith("liz_")) {
            throw new Error("--with-token expects a liz_ API key. Create a workspace-scoped one with `lizard keys create`.");
          }
        }

        const body = {
          template: opts.template,
          size: opts.size,
          snapshotId: opts.snapshot,
          timeoutMs: opts.timeout,
          region: opts.region,
          volumeId,
          volumeName,
          lizardToken,
          projectId,
        };
        try {
          sandbox = await api.post<SandboxRecord>("/api/sandboxes", body);
        } catch (e: any) {
          // Only an id-shaped guess can be wrong this way, and only by 404. Anything
          // else (409 already-attached, 400 wrong scope) is a real answer — rethrow it.
          // An older platform, or a workspace without any project.
          if (e instanceof APIError && e.code === "PROJECT_REQUIRED") {
            throw new Error("No project linked. Run `lizard init` or pass --project <id>.");
          }
          if (!volumeId || e?.status !== 404) throw e;
          const resolved = await resolveVolume(projectId!, scope, opts.volume);
          sandbox = await api.post<SandboxRecord>("/api/sandboxes", {
            ...body, volumeId: resolved.id, volumeName: undefined,
          });
        }
      } catch (e) {
        spinner?.stop();
        throw e;
      }
      spinner?.stop();

      if (isJSONMode()) {
        printJSON(sandbox);
        return;
      }
      success(`Sandbox ${chalk.bold(sandbox.id)} created`);
      if (sandbox.projectDefaulted && sandbox.projectName) {
        info(chalk.dim(`  Project: ${sandbox.projectName} (your default; pass --project for another)`));
      }
      info(chalk.dim(`  Template: ${sandbox.template}  Region: ${sandbox.region}`));
      const machine = `${sandbox.cpus} vCPU / ${sandbox.memoryMb} MB`;
      info(chalk.dim(sandbox.size
        ? `  Size: ${sandbox.size} (${machine})${sandbox.pricePerHour != null ? `, $${sandbox.pricePerHour}/h` : ""}`
        : `  Machine: ${machine}`));
      info(chalk.dim(`  ${lifetimeLine(sandbox.expiresAt ?? sandbox.endAt)}`));
      info("");
      info(sandboxNextSteps(sandbox.id));
    });

  sb.command("list")
    .alias("ls")
    .description("List sandboxes in the linked (or given) project")
    .option("-p, --project <id>", "List sandboxes for this project instead of the linked one")
    .option("--all", "List every sandbox across all your workspaces")
    .action(async (opts) => {
      // `--all` is the only way to get the workspace-wide view. Without it we
      // scope to a project — the linked one, or `--project` — and error like
      // `ps` when nothing is linked, so the default never leaks other members'
      // or other projects' sandboxes.
      if (opts.all) {
        const sandboxes = await api.get<SandboxRecord[]>("/api/sandboxes");
        printSandboxList(sandboxes);
        return;
      }
      const { projectId, scope } = await resolveProjectScope(opts.project);
      const sandboxes = await api.get<SandboxRecord[]>(
        withScope(`/api/projects/${projectId}/sandboxes`, scope),
      );
      printSandboxList(sandboxes);
    });

  sb.command("rm")
    .alias("delete")
    .argument("<id>", "Sandbox ID")
    .description("Delete a sandbox")
    .option("-y, --yes", "Skip confirmation")
    .action(async (id: string, opts) => {
      if (!opts.yes && isTTY() && !isJSONMode()) {
        const ok = await p.confirm({ message: `Delete sandbox ${chalk.bold(id)}?` });
        if (p.isCancel(ok) || !ok) process.exit(5);
      }
      await api.delete(`/api/sandboxes/${id}`);
      if (isJSONMode()) printJSON({ id, status: "deleted" });
      else success(`Sandbox ${chalk.bold(id)} deleted`);
    });

  sb.command("timeout")
    .argument("<id>", "Sandbox ID")
    .argument("<ms>", "New lifetime in milliseconds (minimum 1000)", parseTimeoutOption)
    .description("Update a sandbox's lifetime")
    .action(async (id: string, ms: number) => {
      const updated = await api.post<SandboxRecord>(`/api/sandboxes/${id}/timeout`, { timeoutMs: ms });
      if (isJSONMode()) printJSON(updated);
      else success(`Sandbox ${chalk.bold(id)} timeout set to ${ms}ms`);
    });

  sb.command("exec")
    .argument("<id>", "Sandbox ID")
    .argument("[cmd...]", "Command and args to run (pass after `--`, e.g. `-- ls -la /tmp`)")
    .description("Execute a command inside a sandbox, streaming output")
    .addHelpText(
      "after",
      `
Examples:
  lizard sandbox exec sb_abc123 -- ls -la /tmp
  lizard sandbox exec sb_abc123 -- python3 script.py`,
    )
    .action(async (id: string, cmdArgs: string[]) => {
      if (cmdArgs.length === 0) {
        throw new Error("No command given. Usage: lizard sandbox exec <id> -- <cmd> [args...]");
      }
      // The server runs `cmd` via `/bin/sh -c` only when it's a string — an
      // array execs the binary directly with no PATH lookup or shell
      // features (pipes, globs). Shell-quote and join so `sh -c` sees it.
      const cmd = cmdArgs.map(shellQuote).join(" ");
      if (!isJSONMode()) {
        process.stdout.write(chalk.dim(`$ ${cmd}\n`));
      }
      const exitCode = await execStream(id, cmd, (stream, line) => {
        if (stream === "stderr") process.stderr.write(line + "\n");
        else process.stdout.write(line + "\n");
      });
      process.exit(exitCode);
    });

  registerSandboxAgentCommands(sb);

  sb.command("ssh")
    .alias("shell")
    .argument("<id>", "Sandbox ID")
    .description("Open an interactive shell in a running sandbox")
    .addHelpText(
      "after",
      `
Works for every running sandbox with no keys to set up: it uses your Lizard login,
and a scoped API key only reaches sandboxes in its scope. Ctrl-C, arrows and tab
completion go to the sandbox; type \`exit\` or press Ctrl-D to leave.

To run one command non-interactively, use \`lizard sandbox exec <id> -- <cmd>\`.

Example:
  lizard sandbox ssh sb_abc123`,
    )
    .action(async (id: string) => {
      process.exit(await sandboxShell(id));
    });

  sb.command("expose")
    .argument("<id>", "Sandbox ID")
    .argument("<port>", "Port to expose", parseIntOption)
    .description("Expose a sandbox port over HTTPS")
    .action(async (id: string, port: number) => {
      const result = await api.post<{ hostname: string; url: string; port: number }>(
        `/api/sandboxes/${id}/expose/${port}`,
      );
      if (isJSONMode()) {
        printJSON(result);
        return;
      }
      success(`Port ${port} exposed`);
      info(`  ${chalk.cyan(result.url)}`);
    });

  sb.command("unexpose")
    .argument("<id>", "Sandbox ID")
    .argument("<port>", "Port to unexpose", parseIntOption)
    .description("Remove an exposed sandbox port")
    .action(async (id: string, port: number) => {
      await api.delete(`/api/sandboxes/${id}/expose/${port}`);
      if (isJSONMode()) printJSON({ id, port, status: "unexposed" });
      else success(`Port ${port} unexposed`);
    });

  sb.command("desktop")
    .argument("<id>", "Sandbox ID (created with `-t desktop`)")
    .description("Start a sandbox's graphical desktop and print its browser URL")
    .option("--view-only", "Print/open only the view-only URL (watch, no control)")
    .option("--resolution <WxH>", "Screen size, e.g. 1920x1080 (640-3840 x 480-2160)", parseResolution)
    .option("--open", "Open the desktop in your default browser")
    .option("--status", "Show the desktop's state and URLs without starting it")
    .option("--stop", "Stop the desktop and unpublish its port")
    .addHelpText(
      "after",
      `
Examples:
  lizard sandbox create -t desktop
  lizard sandbox desktop sb_abc123 --open
  lizard sandbox desktop sb_abc123 --resolution 1920x1080
  lizard sandbox desktop sb_abc123 --stop`,
    )
    .action(async (id: string, opts: { viewOnly?: boolean; resolution?: { width: number; height: number }; open?: boolean; status?: boolean; stop?: boolean }) => {
      if (opts.stop && opts.status) throw new Error("--stop and --status can't be combined.");
      if (opts.resolution && (opts.stop || opts.status)) {
        throw new Error("--resolution only applies when starting the desktop; drop --stop/--status.");
      }
      if (opts.open && opts.stop) throw new Error("--open can't be combined with --stop.");

      const path = `/api/sandboxes/${id}/desktop`;
      const label = opts.stop ? "Stopping desktop..." : opts.status ? "Checking desktop..." : "Starting desktop...";
      const spinner = isJSONMode() ? null : ora(label).start();
      let result: DesktopRecord;
      try {
        if (opts.stop) result = await api.delete<DesktopRecord>(path);
        else if (opts.status) result = await api.get<DesktopRecord>(path);
        else result = await api.post<DesktopRecord>(path, opts.resolution ?? {});
      } catch (e) {
        spinner?.stop();
        if (e instanceof APIError && e.code === "DESKTOP_NOT_SUPPORTED") {
          throw new APIError(
            e.status,
            `${e.message}\nSandbox ${id} has no desktop. Create one with: lizard sandbox create -t desktop`,
            e.code,
            e.body,
          );
        }
        throw e;
      }
      spinner?.stop();

      if (isJSONMode()) {
        printJSON(result);
        return;
      }
      if (opts.stop) {
        success(`Desktop stopped on sandbox ${chalk.bold(id)}`);
        return;
      }
      if (!result.running) {
        info(`Desktop is not running on sandbox ${chalk.bold(id)}. Start it with: lizard sandbox desktop ${id}`);
        return;
      }
      const size = result.width && result.height ? ` (${result.width}x${result.height})` : "";
      success(`Desktop ${opts.status ? "running" : "ready"} on sandbox ${chalk.bold(id)}${size}`);
      const target = opts.viewOnly ? result.viewOnlyUrl : result.url;
      if (opts.viewOnly) {
        info(`  View only: ${chalk.cyan(result.viewOnlyUrl)}`);
      } else {
        info(`  ${chalk.cyan(result.url)}`);
        info(chalk.dim(`  View only: ${result.viewOnlyUrl}`));
      }
      info(chalk.yellow(opts.viewOnly
        ? "  This link shows the sandbox's screen; treat it like a password."
        : "  This link grants control of the sandbox; treat it like a password."));
      if (opts.open && target) {
        await open(target).catch(() => {});
        info(chalk.dim("  Opened in browser"));
      }
    });

  sb.command("vnc")
    .argument("<id>", "Sandbox ID (created with `-t desktop`)")
    .description("Connect a VNC app (Screen Sharing, TigerVNC, RealVNC) to a sandbox's desktop")
    .option("--port <port>", "Local port to listen on (the next free one is used if taken)", parseIntOption, 5900)
    .option("--view-only", "Use the view-only password: watch, no control")
    .option("--open", "Open the address in your VNC app (vnc:// — Screen Sharing on macOS)")
    .addHelpText(
      "after",
      `
The desktop has no public VNC port. This listens on localhost and tunnels each
connection over the desktop's secured WebSocket, so point any VNC app at the
address it prints and enter the password. Runs until Ctrl-C.

Examples:
  lizard sandbox vnc sb_abc123            # then connect your VNC app to localhost:5900
  lizard sandbox vnc sb_abc123 --open     # macOS: opens Screen Sharing
  lizard sandbox vnc sb_abc123 --view-only`,
    )
    .action(async (id: string, opts: { port: number; viewOnly?: boolean; open?: boolean }) => {
      const spinner = isJSONMode() ? null : ora("Starting desktop...").start();
      let result: DesktopRecord;
      try {
        result = await api.post<DesktopRecord>(`/api/sandboxes/${id}/desktop`, {});
      } catch (e) {
        spinner?.stop();
        if (e instanceof APIError && e.code === "DESKTOP_NOT_SUPPORTED") {
          throw new APIError(e.status, `${e.message}\nCreate a desktop sandbox with: lizard sandbox create -t desktop`, e.code, e.body);
        }
        throw e;
      }
      spinner?.stop();
      const desktopUrl = opts.viewOnly ? result.viewOnlyUrl : result.url;
      if (!result.running || !desktopUrl) throw new Error(`The desktop on sandbox ${id} did not start.`);
      const { wsUrl, password, headers } = vncTarget(desktopUrl);

      const tunnel = await startVncTunnel(wsUrl, opts.port, {
        onConnect: () => { if (!isJSONMode()) info(chalk.dim(`  VNC app connected`)); },
        onClose: (reason) => { if (!isJSONMode()) info(chalk.dim(`  VNC app session ended: ${reason}`)); },
      }, headers);
      const address = `localhost:${tunnel.port}`;
      if (isJSONMode()) {
        printJSON({ id, address, host: "127.0.0.1", port: tunnel.port, password, viewOnly: !!opts.viewOnly });
      } else {
        success(`VNC ready for sandbox ${chalk.bold(id)}${opts.viewOnly ? " (view only)" : ""}`);
        info(`  Address:  ${chalk.cyan(address)}`);
        info(`  Password: ${chalk.cyan(password)}`);
        info(chalk.dim(`  Connect any VNC app to the address above; on macOS: open vnc://${address}`));
        info(chalk.dim("  Ctrl-C to stop"));
      }
      if (opts.open) {
        // Screen Sharing takes the password from the URL, so it connects without a prompt.
        await open(`vnc://:${encodeURIComponent(password)}@${address}`).catch(() => {});
      }
      await new Promise<void>((resolve) => {
        const stop = () => { tunnel.close(); resolve(); };
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
      });
    });

  sb.command("snapshot")
    .argument("<id>", "Running sandbox ID")
    .requiredOption("--name <name>", "Name for this private snapshot")
    .addOption(new Option("--scope <scope>", "Where it may be restored: user = any of your projects and workspaces, workspace = only this workspace, project = only this project. Default: user, or with a workspace/project-scoped key only what the key covers")
      .choices(SNAPSHOT_SCOPES))
    .option("--no-wait", "Return once capture is queued")
    .description("Save a running sandbox, memory included")
    .action(async (id: string, opts) => {
      // No pool size: Firecracker and gVisor snapshots keep no warm copies, and a runc pod
      // (the fallback when a Firecracker create fails) gets the server's default.
      let snapshot = await api.post<SnapshotRecord>(`/api/sandboxes/${id}/snapshot`, { name: opts.name, scope: opts.scope });
      if (opts.wait) snapshot = await waitForSnapshot(snapshot.id);
      if (isJSONMode()) printJSON(snapshot);
      else success(`Snapshot ${chalk.bold(snapshot.id)}: ${snapshot.status}`);
    });

  for (const operation of ["pause", "resume"] as const) {
    sb.command(operation)
      .argument("<id>", "Sandbox ID")
      .option("--no-wait", "Return once the operation is queued")
      .description(operation === "pause" ? "Save running state (memory and files) and stop the sandbox" : "Restore a paused sandbox with its saved memory and files")
      .action(async (id: string, opts) => {
        const queued = await api.post<{ id: string; status: string; snapshotId?: string }>(`/api/sandboxes/${id}/${operation}`, {});
        if (opts.wait && operation === 'pause' && queued.snapshotId) await waitForSnapshot(queued.snapshotId);
        const result = opts.wait ? await waitForSandbox(id, operation === "pause" ? "paused" : "running") : queued;
        if (isJSONMode()) printJSON(result);
        else success(`Sandbox ${chalk.bold(id)}: ${result.status}`);
      });
  }

  sb.command("restore")
    .argument("<snapshot-id>", "Saved snapshot ID")
    .option("--timeout <ms>", "Lifetime in milliseconds; 0 disables expiration", parseTimeoutOption, 300_000)
    .option("-p, --project <id>", "Project to start it in, in any of your workspaces (name, slug, or ID); defaults to the volume's project, else the snapshot's own")
    .option("--volume <name-or-id>", "Mount this volume at /workspace (Firecracker snapshot of a sandbox that had no volume; same region)")
    .description("Start a new sandbox from a private snapshot")
    .action(async (snapshotId: string, opts) => {
      const [snapshot, projectId] = await Promise.all([
        api.get<SnapshotRecord>(`/api/sandbox-snapshots/${snapshotId}`),
        opts.project ? resolveProjectId(opts.project) : Promise.resolve(undefined),
      ]);
      const volume = opts.volume ? ((/^fcv-/.test(opts.volume) || looksLikeId(opts.volume)) ? { volumeId: opts.volume } : { volumeName: opts.volume }) : {};
      // A volume picks its own project when none is named; a name needs one to be found in.
      const project = projectId ?? (volume.volumeId ? undefined : snapshot.projectId);
      const sandbox = await api.post<SandboxRecord>("/api/sandboxes", { snapshotId, projectId: project, region: snapshot.region, timeoutMs: opts.timeout, ...volume });
      if (isJSONMode()) printJSON(sandbox);
      else success(`Sandbox ${chalk.bold(sandbox.id)} created from ${snapshot.name}`);
    });

  // Warm pools exist only for CRIU snapshots of runc pod sandboxes, which are no longer
  // created. These stay, out of the help, for the few such snapshots still around.
  for (const operation of ["pause", "resume"] as const) {
    sb.command(`snapshot-${operation}`, { hidden: true })
      .argument("<snapshot-id>", "Saved snapshot ID")
      .description(operation === "pause" ? "Release an older snapshot's warm copies and keep its saved state" : "Refill a paused older snapshot's warm pool")
      .action(async (id: string) => {
        const snapshot = await api.post<SnapshotRecord>(`/api/sandbox-snapshots/${id}/${operation}`, {});
        if (isJSONMode()) printJSON(snapshot);
        else success(`Snapshot ${chalk.bold(id)}: ${snapshot.status}`);
      });
  }

  sb.command("snapshot-warm", { hidden: true })
    .argument("<snapshot-id>", "Saved snapshot ID")
    .argument("<count>", "Copies to keep ready (1–10)", parseWarmCount)
    .description("Change an older snapshot's warm pool size (Firecracker snapshots have none)")
    .action(async (id: string, count: number) => {
      const snapshot = await api.patch<SnapshotRecord>(`/api/sandbox-snapshots/${id}`, { poolSize: count });
      if (isJSONMode()) printJSON(snapshot);
      else success(`Snapshot ${chalk.bold(id)} will keep ${count} copies warm`);
    });

  sb.command("snapshot-scope")
    .argument("<snapshot-id>", "Saved snapshot ID")
    .argument("<scope>", `Where it may be restored: ${SNAPSHOT_SCOPES.join(" | ")}`, parseSnapshotScope)
    .description("Change where a snapshot you took may be restored: user = any of your projects and workspaces, workspace = only its workspace, project = only its project")
    .action(async (id: string, scope: string) => {
      const snapshot = await api.patch<SnapshotRecord>(`/api/sandbox-snapshots/${id}`, { scope });
      if (isJSONMode()) printJSON(snapshot);
      else success(`Snapshot ${chalk.bold(id)} can now be restored ${SCOPE_TEXT[scope]}`);
    });

  sb.command("snapshots")
    .description("List persistent sandbox snapshots in the linked (or given) project, or --mine for every snapshot you took")
    .option("-p, --project <id>", "List snapshots for this project instead of the linked one")
    .option("--mine", "Every snapshot you took, across all your workspaces and projects")
    .action(async (opts) => {
      let path = "/api/sandbox-snapshots";
      if (!opts.mine) {
        const { projectId, scope } = await resolveProjectScope(opts.project);
        path = withScope(`/api/projects/${projectId}/snapshots`, scope);
      }
      const snaps = await api.get<Array<{ id: string; template: string; name?: string; region: string; projectId: string; scope?: string; sourceSandboxId?: string; cpus: number; memoryMb: number; createdAt: number }>>(path);
      if (isJSONMode()) { printJSON(snaps); return; }
      if (!snaps.length) { console.log("No snapshots."); return; }
      table(
        ["Snapshot ID", "Name", "Scope", "Project", "Region", "CPU/Mem", "Created"],
        snaps.map((s) => [s.id, s.name ?? "", s.scope ?? "project", s.projectId, s.region, `${s.cpus} vCPU / ${s.memoryMb} MB`, timeAgo(s.createdAt as any)]),
      );
    });

  sb.command("snapshot-rm")
    .alias("snapshot-delete")
    .argument("<snapshot-id>", "Snapshot ID")
    .description("Delete a persistent snapshot")
    .option("-y, --yes", "Skip confirmation")
    .action(async (snapshotId: string, opts) => {
      if (!opts.yes && isTTY() && !isJSONMode()) {
        const ok = await p.confirm({ message: `Delete snapshot ${chalk.bold(snapshotId)}?` });
        if (p.isCancel(ok) || !ok) process.exit(5);
      }
      await api.delete(`/api/sandbox-snapshots/${snapshotId}`);
      if (isJSONMode()) printJSON({ id: snapshotId, status: "deleted" });
      else success(`Snapshot ${chalk.bold(snapshotId)} deleted`);
    });

  registerSandboxFiles(sb);
}

function registerSandboxFiles(sb: Command) {
  const files = sb.command("files").description("Manage files inside a sandbox");

  files
    .command("ls")
    .argument("<id>", "Sandbox ID")
    .argument("[path]", "Directory to list", "/")
    .description("List a directory inside a sandbox")
    .action(async (id: string, path: string) => {
      const entries = await api.get<Array<{ type: string; name: string; path: string; size: number }>>(
        withQuery(`/api/sandboxes/${id}/files/list`, { path }),
      );
      if (isJSONMode()) {
        printJSON(entries);
        return;
      }
      if (entries.length === 0) {
        console.log("(empty)");
        return;
      }
      table(
        ["Type", "Name", "Size"],
        entries.map((e) => [e.type, e.name, e.type === "dir" ? "" : `${e.size}B`]),
      );
    });

  files
    .command("cat")
    .argument("<id>", "Sandbox ID")
    .argument("<path>", "File path inside the sandbox")
    .description("Print a file from inside a sandbox")
    .action(async (id: string, path: string) => {
      const content = await getRawBytes(withQuery(`/api/sandboxes/${id}/files`, { path }));
      process.stdout.write(content);
    });

  files
    .command("put")
    .argument("<id>", "Sandbox ID")
    .argument("<local>", "Local file path")
    .argument("<remote>", "Destination path inside the sandbox")
    .description("Upload a local file into a sandbox")
    .action(async (id: string, local: string, remote: string) => {
      const content = fs.readFileSync(local).toString("base64");
      await api.post(`/api/sandboxes/${id}/files`, { path: remote, content, encoding: "base64" });
      if (isJSONMode()) printJSON({ id, path: remote, status: "written" });
      else success(`Wrote ${chalk.bold(remote)} in sandbox ${id}`);
    });

  files
    .command("get")
    .argument("<id>", "Sandbox ID")
    .argument("<remote>", "File path inside the sandbox")
    .argument("<local>", "Local destination path")
    .description("Download a file from a sandbox")
    .action(async (id: string, remote: string, local: string) => {
      const content = await getRawBytes(withQuery(`/api/sandboxes/${id}/files`, { path: remote }));
      fs.writeFileSync(local, content);
      if (isJSONMode()) printJSON({ id, path: remote, local, status: "downloaded" });
      else success(`Downloaded ${chalk.bold(remote)} to ${local}`);
    });

  files
    .command("rm")
    .argument("<id>", "Sandbox ID")
    .argument("<path>", "Path inside the sandbox")
    .description("Delete a file or directory inside a sandbox")
    .action(async (id: string, path: string) => {
      await api.delete(`/api/sandboxes/${id}/files`, { path });
      if (isJSONMode()) printJSON({ id, path, status: "deleted" });
      else success(`Deleted ${chalk.bold(path)} in sandbox ${id}`);
    });
}

/** Run a command inside a sandbox, streaming output. Resolves with the exit
 *  code: the remote command's code from the `exit` event, or 1 when the
 *  server reported an `error` event without one. Mirrors ssh.ts's parser. */
export function execStream(
  sandboxId: string,
  cmd: string,
  onLine: (stream: string, line: string) => void,
): Promise<number> {
  return new Promise((resolve, reject) => {
    let exitCode: number | null = null;
    let sawError = false;
    const baseURL = getBaseURL();
    const url = new URL(`${baseURL}/api/sandboxes/${sandboxId}/exec`);
    const token = getRequestToken();
    const body = JSON.stringify({ cmd });

    const reqHeaders: Record<string, string> = {
      ...clientHeaders(),
      "Content-Type": "application/json",
      "Content-Length": String(Buffer.byteLength(body)),
      Accept: "text/event-stream",
    };
    if (token) reqHeaders["Authorization"] = `Bearer ${token}`;

    const transport = url.protocol === "https:" ? https : http;
    const req = transport.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname + url.search,
        method: "POST",
        headers: reqHeaders,
      },
      (res) => {
        res.on("error", reject);
        if (res.statusCode && res.statusCode >= 400) {
          let errBody = "";
          res.on("data", (c: Buffer) => (errBody += c.toString()));
          res.on("end", () => {
            let body: unknown = null;
            try { body = JSON.parse(errBody); } catch {}
            reject(apiErrorFrom(res.statusCode!, res.statusMessage || "Exec failed", body));
          });
          return;
        }

        let buf = "";
        let currentEvent = "";
        let dataLines: string[] = [];
        const dispatch = () => {
          if (!dataLines.length) { currentEvent = ""; return; }
          const data = dataLines.join("\n");
          if (currentEvent === "exit") {
            try {
              const code: unknown = JSON.parse(data).exitCode;
              // -1: the platform stopped waiting (150 s). Say so; the bare "invalid event"
              // left agents guessing and retrying the same long command.
              if (code === -1) {
                reject(new APIError(408,
                  "The command was still running after 150 seconds, so exec stopped waiting (it may still be running in the sandbox). " +
                  `Start long jobs in the background and read a log: lizard sandbox exec ${sandboxId} -- sh -c 'nohup <cmd> > /tmp/job.log 2>&1 &', ` +
                  `then lizard sandbox exec ${sandboxId} -- tail -n 50 /tmp/job.log`,
                  "EXEC_TIMEOUT"));
                return;
              }
              if (!Number.isInteger(code) || (code as number) < 0 || (code as number) > 255) {
                throw new Error("Invalid exec exit code");
              }
              exitCode = code as number;
            } catch { reject(new Error("Invalid exec exit event")); }
          } else if (currentEvent === "error") {
            sawError = true;
            error(data);
          } else {
            try {
              const parsed = JSON.parse(data);
              onLine(parsed.stream ?? "stdout", parsed.line ?? data);
            } catch { onLine("stdout", data); }
          }
          currentEvent = "";
          dataLines = [];
        };
        const line = (value: string) => {
          const trimmed = value.replace(/\r$/, "");
          if (!trimmed) dispatch();
          else if (trimmed.startsWith("event:")) currentEvent = trimmed.slice(6).trim();
          else if (trimmed.startsWith("data:")) dataLines.push(trimmed.slice(5).replace(/^ /, ""));
        };
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          buf += chunk;
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";
          for (const value of lines) line(value);
        });
        res.on("end", () => {
          if (buf) line(buf);
          dispatch();
          if (sawError && (exitCode === null || exitCode === 0)) { resolve(1); return; }
          if (exitCode === null) {
            reject(new APIError(502, "Exec stream ended without an exit event", "EXEC_STREAM_INCOMPLETE"));
            return;
          }
          resolve(exitCode);
        });
      },
    );

    req.on("error", (err: NodeJS.ErrnoException) => {
      reject(err.code === "ETIMEDOUT" ? new APIError(408, "Exec request timed out") : err);
    });
    req.write(body);
    req.end();
  });
}

/** POSIX single-quote escaping. Safe-token chars pass through verbatim;
 *  anything else gets wrapped in '…' with embedded `'` rewritten as `'\''`. */
function shellQuote(arg: string): string {
  if (arg === "") return "''";
  if (/^[A-Za-z0-9_./:=@%+,-]+$/.test(arg)) return arg;
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}

interface DesktopRecord {
  running: boolean;
  width?: number | null;
  height?: number | null;
  url?: string;
  viewOnlyUrl?: string;
}

/** Parse `WxH` (e.g. 1920x1080) and check the bounds the server enforces, so a typo
 *  fails before a round trip that would start the desktop at the wrong size. */
export function parseResolution(value: string): { width: number; height: number } {
  const m = /^(\d+)[xX](\d+)$/.exec(value.trim());
  if (!m) throw new Error(`Invalid resolution "${value}": use WxH, e.g. 1920x1080`);
  const width = Number(m[1]);
  const height = Number(m[2]);
  if (width < 640 || width > 3840) throw new Error(`Resolution width must be 640-3840 (got ${width})`);
  if (height < 480 || height > 2160) throw new Error(`Resolution height must be 480-2160 (got ${height})`);
  return { width, height };
}

interface SnapshotRecord {
  id: string; name: string; projectId: string; region: string; status: string;
  poolSize: number; readyCount: number; error?: string; scope?: string;
}
const SNAPSHOT_SCOPES = ["user", "workspace", "project"];
const SCOPE_TEXT: Record<string, string> = { user: "in any of your projects and workspaces", workspace: "only in its own workspace", project: "only in its own project" };
function parseSnapshotScope(value: string): string {
  if (!SNAPSHOT_SCOPES.includes(value)) throw new Error(`Scope must be one of: ${SNAPSHOT_SCOPES.join(", ")}`);
  return value;
}
function parseWarmCount(value: string): number {
  if (!/^[0-9]+$/.test(value) || Number(value) < 1 || Number(value) > 10) throw new Error("Warm copies must be an integer between 1 and 10");
  return Number(value);
}
async function waitForSnapshot(id: string): Promise<SnapshotRecord> {
  const deadline = Date.now() + 20 * 60_000;
  while (Date.now() < deadline) {
    const snapshot = await api.get<SnapshotRecord>(`/api/sandbox-snapshots/${id}`);
    if (snapshot.status === "failed") throw new Error(snapshot.error || "Snapshot capture failed");
    if (snapshot.status === "ready") return snapshot;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error(`Snapshot is still processing. Check it with lizard sandbox snapshots.`);
}
async function waitForSandbox(id: string, target: string): Promise<{ id: string; status: string }> {
  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    const sandbox = await api.get<{ id: string; status: string }>(`/api/sandboxes/${id}`);
    if (sandbox.status === target) return sandbox;
    if (!["running", "pausing", "paused", "resuming"].includes(sandbox.status)) throw new Error(`Sandbox ${id} is ${sandbox.status}`);
    if (target === 'running' && sandbox.status === 'paused') throw new Error('Resume failed; the saved checkpoint is retained. Retry resume.');
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error(`Sandbox ${id} is still processing; check its status.`);
}
