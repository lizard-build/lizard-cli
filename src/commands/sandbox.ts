import chalk from "chalk";
import ora from "ora";
import fs from "node:fs";
import * as https from "node:https";
import * as http from "node:http";
import * as p from "@clack/prompts";
import { Command } from "commander";
import { api, getBaseURL, getRawText, streamSSE, withQuery, withScope, type ResourceScope } from "../lib/api.js";
import { getToken } from "../lib/auth.js";
import { resolveProjectScope } from "../lib/resolve.js";
import { success, info, error, isJSONMode, printJSON, table, statusColor, timeAgo, isTTY } from "../lib/format.js";

const VALID_TEMPLATES = ["base", "code-interpreter-v1"] as const;

interface SandboxRecord {
  sandboxId: string;
  id: string;
  template: string;
  status: string;
  region: string;
  cpus: number;
  memoryMb: number;
  guestIp?: string;
  startedAt: number | string;
  endAt?: number | string;
  expiresAt?: number | string;
  projectId?: string | null;
}

interface VolumeRecord {
  id: string;
  name: string;
}

function parseIntOption(v: string): number {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) throw new Error(`Invalid number: ${v}`);
  return n;
}

/** Resolve a volume by name or ID. Requires a project — volumes are project-scoped. */
async function resolveVolumeId(
  projectId: string,
  scope: ResourceScope,
  nameOrId: string,
): Promise<string> {
  const volumes = await api.get<VolumeRecord[]>(
    withScope(`/api/projects/${projectId}/volumes`, scope),
  );
  const lower = nameOrId.toLowerCase();
  const match = volumes.find(
    (v) => v.id.toLowerCase() === lower || v.name.toLowerCase() === lower,
  );
  if (!match) {
    throw new Error(
      `Volume "${nameOrId}" not found. Available: ${volumes.map((v) => v.name).join(", ") || "(none)"}`,
    );
  }
  return match.id;
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
    ["ID", "Template", "Status", "Region", "CPU/Mem", "Created"],
    sandboxes.map((s) => [
      s.id,
      s.template,
      statusColor(s.status),
      s.region,
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
    .option("-t, --template <name>", `Template (${VALID_TEMPLATES.join(", ")})`, "base")
    .option("--timeout <ms>", "Idle timeout in ms before auto-stop (default 300000)", parseIntOption)
    .option("--region <code>", "Region to create the sandbox in")
    .option("--volume <name-or-id>", "Attach a persistent volume")
    .option("-p, --project <id>", "Project to create the sandbox in (name, slug, or ID). Defaults to the linked project.")
    .action(async (opts) => {
      if (opts.template && !(VALID_TEMPLATES as readonly string[]).includes(opts.template)) {
        throw new Error(`Unknown template "${opts.template}". Available: ${VALID_TEMPLATES.join(", ")}`);
      }

      // A sandbox must belong to a project — billing is metered per project.
      // resolveProjectScope throws a clear "No project linked…" error when
      // there's no --project and the cwd isn't linked, so the CLI can never
      // create a project-less sandbox.
      const { projectId, scope } = await resolveProjectScope(opts.project);
      const workspaceId = scope.workspaceId ?? undefined;

      let volumeId: string | undefined;
      if (opts.volume) {
        volumeId = await resolveVolumeId(projectId, scope, opts.volume);
      }

      const spinner = isJSONMode() ? null : ora("Creating sandbox...").start();
      let sandbox: SandboxRecord;
      try {
        sandbox = await api.post<SandboxRecord>("/api/sandboxes", {
          template: opts.template,
          timeoutMs: opts.timeout,
          region: opts.region,
          volumeId,
          workspaceId,
          projectId,
        });
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
      info(chalk.dim(`  Template: ${sandbox.template}  Region: ${sandbox.region}`));
      info(chalk.dim(`  Exec: lizard sandbox exec ${sandbox.id} -- <cmd>`));
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

  sb.command("pause")
    .argument("<id>", "Sandbox ID")
    .description("Pause a sandbox")
    .action(async (id: string) => {
      const updated = await api.post<SandboxRecord>(`/api/sandboxes/${id}/pause`);
      if (isJSONMode()) printJSON(updated);
      else success(`Sandbox ${chalk.bold(id)} paused`);
    });

  sb.command("resume")
    .argument("<id>", "Sandbox ID")
    .description("Resume a paused sandbox")
    .action(async (id: string) => {
      const updated = await api.post<SandboxRecord>(`/api/sandboxes/${id}/resume`);
      if (isJSONMode()) printJSON(updated);
      else success(`Sandbox ${chalk.bold(id)} resumed`);
    });

  sb.command("timeout")
    .argument("<id>", "Sandbox ID")
    .argument("<ms>", "New idle timeout in milliseconds", parseIntOption)
    .description("Update a sandbox's idle timeout")
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

  sb.command("logs")
    .argument("<id>", "Sandbox ID")
    .description("Stream sandbox vm-agent logs")
    .option("--tail <n>", "Number of historical lines to include before following", "200")
    .action(async (id: string, opts) => {
      info(chalk.dim("Streaming logs... (Ctrl+C to stop)\n"));
      await streamSSE(withQuery(`/api/sandboxes/${id}/logs`, { tail: opts.tail }), (_event, data) => {
        let parsed: any;
        try {
          parsed = JSON.parse(data);
        } catch {
          parsed = { message: data };
        }
        if (isJSONMode()) {
          process.stdout.write(JSON.stringify(parsed) + "\n");
        } else {
          process.stdout.write((parsed.message ?? data) + "\n");
        }
        return true;
      });
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
      const content = await getRawText(withQuery(`/api/sandboxes/${id}/files`, { path }));
      process.stdout.write(content);
    });

  files
    .command("put")
    .argument("<id>", "Sandbox ID")
    .argument("<local>", "Local file path")
    .argument("<remote>", "Destination path inside the sandbox")
    .description("Upload a local file into a sandbox")
    .action(async (id: string, local: string, remote: string) => {
      const content = fs.readFileSync(local, "utf-8");
      await api.post(`/api/sandboxes/${id}/files`, { path: remote, content });
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
      const content = await getRawText(withQuery(`/api/sandboxes/${id}/files`, { path: remote }));
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
function execStream(
  sandboxId: string,
  cmd: string,
  onLine: (stream: string, line: string) => void,
): Promise<number> {
  return new Promise((resolve, reject) => {
    let exitCode: number | null = null;
    let sawError = false;
    const baseURL = getBaseURL();
    const url = new URL(`${baseURL}/api/sandboxes/${sandboxId}/exec`);
    const token = getToken();
    const body = JSON.stringify({ cmd });

    const reqHeaders: Record<string, string> = {
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
        path: url.pathname,
        method: "POST",
        headers: reqHeaders,
      },
      (res) => {
        if (res.statusCode && res.statusCode >= 400) {
          let errBody = "";
          res.on("data", (c: Buffer) => (errBody += c.toString()));
          res.on("end", () => reject(new Error(`exec failed ${res.statusCode}: ${errBody}`)));
          return;
        }

        let buf = "";
        let currentEvent = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          buf += chunk;
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";

          for (const line of lines) {
            const trimmed = line.replace(/\r$/, "");
            if (trimmed === "") {
              currentEvent = "";
            } else if (trimmed.startsWith("event:")) {
              currentEvent = trimmed.slice(6).trim();
            } else if (trimmed.startsWith("data:")) {
              const data = trimmed.slice(5).trimStart();
              if (currentEvent === "exit") {
                try { exitCode = JSON.parse(data).exitCode ?? 0; } catch {}
              } else if (currentEvent === "error") {
                sawError = true;
                error(data);
              } else {
                try {
                  const parsed = JSON.parse(data);
                  onLine(parsed.stream ?? "stdout", parsed.line ?? data);
                } catch {
                  onLine("stdout", data);
                }
              }
            }
          }
        });

        res.on("end", () => resolve(exitCode ?? (sawError ? 1 : 0)));
        res.on("error", reject);
      },
    );

    req.on("error", reject);
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
