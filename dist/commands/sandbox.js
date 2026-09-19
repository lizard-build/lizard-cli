import chalk from "chalk";
import ora from "ora";
import fs from "node:fs";
import * as https from "node:https";
import * as http from "node:http";
import * as p from "@clack/prompts";
import { api, getBaseURL, getRawText, streamSSE, withQuery, withScope } from "../lib/api.js";
import { getToken } from "../lib/auth.js";
import { resolveProjectScope } from "../lib/resolve.js";
import { resolveProjectId } from "../lib/config.js";
import { resolveVolume } from "../lib/volume.js";
import { success, info, error, isJSONMode, printJSON, table, statusColor, timeAgo, isTTY } from "../lib/format.js";
// Templates are per-region rows in sandbox_templates, not a constant. Hardcoding them
// here meant a template that was built, registered and sitting warm in every region was
// still rejected before a request was ever sent — codex and interpreter both were. The
// server validates against the region's actual list and answers with what IS available,
// so let it.
const TEMPLATE_HINT = "base, codex, interpreter";
function parseIntOption(v) {
    const n = parseInt(v, 10);
    if (Number.isNaN(n))
        throw new Error(`Invalid number: ${v}`);
    return n;
}
function parseTimeoutOption(value) {
    const timeout = Number(value);
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(timeout) || timeout > 2_147_483_647) {
        throw new Error("Timeout must be an integer from 0 to 2147483647 milliseconds");
    }
    return timeout;
}
function printSandboxList(sandboxes) {
    if (isJSONMode()) {
        printJSON(sandboxes);
        return;
    }
    if (sandboxes.length === 0) {
        console.log("No sandboxes. Use `lizard sandbox create`.");
        return;
    }
    table(["ID", "Template", "Status", "Region", "CPU/Mem", "Created"], sandboxes.map((s) => [
        s.id,
        s.template,
        statusColor(s.status),
        s.region,
        `${s.cpus} vCPU / ${s.memoryMb} MB`,
        timeAgo(s.startedAt),
    ]));
}
export function registerSandbox(program) {
    const sb = program
        .command("sandbox")
        .alias("sb")
        .description("Manage ephemeral compute sandboxes");
    sb.command("create")
        .description("Create a sandbox")
        .option("-t, --template <name>", `Template (${TEMPLATE_HINT}; server validates)`, "base")
        .option("--timeout <ms>", "Lifetime in milliseconds; 0 disables expiration", parseTimeoutOption, 300_000)
        .option("--region <code>", "Region to create the sandbox in")
        .option("--volume <name-or-id>", "Attach a persistent volume")
        .option("-p, --project <id>", "Project to create the sandbox in (name, slug, or ID). Defaults to the linked project.")
        .action(async (opts) => {
        // A sandbox must belong to a project — billing is metered per project.
        // resolveProjectScope throws a clear "No project linked…" error when
        // there's no --project and the cwd isn't linked, so the CLI can never
        // create a project-less sandbox.
        // Deliberately NOT resolveProjectScope: that fetches the project purely to learn
        // its workspaceId, which the create endpoint looks up itself anyway, overlapped
        // with auth so it costs the server nothing. Sending it bought nothing and cost the
        // client a round trip — 113ms of a 1083ms create measured from EU.
        const projectId = await resolveProjectId(opts.project);
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
        let volumeId;
        let volumeName;
        if (opts.volume) {
            if (/^[A-Za-z0-9_-]{21}$/.test(opts.volume))
                volumeId = opts.volume;
            else
                volumeName = opts.volume;
        }
        const spinner = isJSONMode() ? null : ora("Creating sandbox...").start();
        let sandbox;
        try {
            const body = {
                template: opts.template,
                timeoutMs: opts.timeout,
                region: opts.region,
                volumeId,
                volumeName,
                projectId,
            };
            try {
                sandbox = await api.post("/api/sandboxes", body);
            }
            catch (e) {
                // Only an id-shaped guess can be wrong this way, and only by 404. Anything
                // else (409 already-attached, 400 wrong scope) is a real answer — rethrow it.
                if (!volumeId || e?.status !== 404)
                    throw e;
                const resolved = await resolveVolume(projectId, scope, opts.volume);
                sandbox = await api.post("/api/sandboxes", {
                    ...body, volumeId: resolved.id, volumeName: undefined,
                });
            }
        }
        catch (e) {
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
            const sandboxes = await api.get("/api/sandboxes");
            printSandboxList(sandboxes);
            return;
        }
        const { projectId, scope } = await resolveProjectScope(opts.project);
        const sandboxes = await api.get(withScope(`/api/projects/${projectId}/sandboxes`, scope));
        printSandboxList(sandboxes);
    });
    sb.command("rm")
        .alias("delete")
        .argument("<id>", "Sandbox ID")
        .description("Delete a sandbox")
        .option("-y, --yes", "Skip confirmation")
        .action(async (id, opts) => {
        if (!opts.yes && isTTY() && !isJSONMode()) {
            const ok = await p.confirm({ message: `Delete sandbox ${chalk.bold(id)}?` });
            if (p.isCancel(ok) || !ok)
                process.exit(5);
        }
        await api.delete(`/api/sandboxes/${id}`);
        if (isJSONMode())
            printJSON({ id, status: "deleted" });
        else
            success(`Sandbox ${chalk.bold(id)} deleted`);
    });
    sb.command("pause")
        .argument("<id>", "Sandbox ID")
        .description("Pause a sandbox")
        .action(async (id) => {
        const updated = await api.post(`/api/sandboxes/${id}/pause`);
        if (isJSONMode())
            printJSON(updated);
        else
            success(`Sandbox ${chalk.bold(id)} paused`);
    });
    sb.command("resume")
        .argument("<id>", "Sandbox ID")
        .description("Resume a paused sandbox")
        .action(async (id) => {
        const updated = await api.post(`/api/sandboxes/${id}/resume`);
        if (isJSONMode())
            printJSON(updated);
        else
            success(`Sandbox ${chalk.bold(id)} resumed`);
    });
    sb.command("timeout")
        .argument("<id>", "Sandbox ID")
        .argument("<ms>", "New lifetime in milliseconds (minimum 1000)", parseTimeoutOption)
        .description("Update a sandbox's lifetime")
        .action(async (id, ms) => {
        const updated = await api.post(`/api/sandboxes/${id}/timeout`, { timeoutMs: ms });
        if (isJSONMode())
            printJSON(updated);
        else
            success(`Sandbox ${chalk.bold(id)} timeout set to ${ms}ms`);
    });
    sb.command("exec")
        .argument("<id>", "Sandbox ID")
        .argument("[cmd...]", "Command and args to run (pass after `--`, e.g. `-- ls -la /tmp`)")
        .description("Execute a command inside a sandbox, streaming output")
        .addHelpText("after", `
Examples:
  lizard sandbox exec sb_abc123 -- ls -la /tmp
  lizard sandbox exec sb_abc123 -- python3 script.py`)
        .action(async (id, cmdArgs) => {
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
            if (stream === "stderr")
                process.stderr.write(line + "\n");
            else
                process.stdout.write(line + "\n");
        });
        process.exit(exitCode);
    });
    sb.command("logs")
        .argument("<id>", "Sandbox ID")
        .description("Stream sandbox vm-agent logs")
        .option("--tail <n>", "Number of historical lines to include before following", "200")
        .action(async (id, opts) => {
        info(chalk.dim("Streaming logs... (Ctrl+C to stop)\n"));
        await streamSSE(withQuery(`/api/sandboxes/${id}/logs`, { tail: opts.tail }), (_event, data) => {
            let parsed;
            try {
                parsed = JSON.parse(data);
            }
            catch {
                parsed = { message: data };
            }
            if (isJSONMode()) {
                process.stdout.write(JSON.stringify(parsed) + "\n");
            }
            else {
                process.stdout.write((parsed.message ?? data) + "\n");
            }
            return true;
        });
    });
    sb.command("expose")
        .argument("<id>", "Sandbox ID")
        .argument("<port>", "Port to expose", parseIntOption)
        .description("Expose a sandbox port over HTTPS")
        .action(async (id, port) => {
        const result = await api.post(`/api/sandboxes/${id}/expose/${port}`);
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
        .action(async (id, port) => {
        await api.delete(`/api/sandboxes/${id}/expose/${port}`);
        if (isJSONMode())
            printJSON({ id, port, status: "unexposed" });
        else
            success(`Port ${port} unexposed`);
    });
    sb.command("fork")
        .argument("<id>", "Running sandbox ID to fork")
        .description("Checkpoint a running sandbox and boot one or more forks from it")
        .option("-n, --count <n>", "Number of forks to boot", parseIntOption, 1)
        .option("--timeout <ms>", "Fork lifetime in milliseconds; 0 disables expiration", parseTimeoutOption, 0)
        .action(async (id, opts) => {
        const spinner = isJSONMode() ? null : ora(`Forking ${id}...`).start();
        let res;
        try {
            res = await api.post(`/api/sandboxes/${id}/fork`, { count: opts.count, timeoutMs: opts.timeout });
        }
        catch (e) {
            spinner?.stop();
            throw e;
        }
        spinner?.stop();
        if (isJSONMode()) {
            printJSON(res);
            return;
        }
        const ok = res.results.filter((r) => r.sandbox).map((r) => r.sandbox);
        const failed = res.results.filter((r) => r.error);
        success(`Forked ${chalk.bold(id)} → ${ok.length}/${res.results.length} fork(s)`);
        if (ok.length)
            printSandboxList(ok);
        for (const f of failed)
            error(f.error.message);
    });
    sb.command("snapshot")
        .argument("<id>", "Running sandbox ID")
        .description("Create a persistent snapshot of a running sandbox (fork from it later)")
        .option("--name <name>", "Optional label for the snapshot")
        .action(async (id, opts) => {
        const spinner = isJSONMode() ? null : ora(`Snapshotting ${id}...`).start();
        let snap;
        try {
            snap = await api.post(`/api/sandboxes/${id}/snapshot`, { name: opts.name });
        }
        catch (e) {
            spinner?.stop();
            throw e;
        }
        spinner?.stop();
        if (isJSONMode()) {
            printJSON(snap);
            return;
        }
        success(`Snapshot ${chalk.bold(snap.id)} created`);
        info(chalk.dim(`  Restore: lizard sandbox restore ${snap.id}`));
    });
    sb.command("snapshots")
        .description("List persistent sandbox snapshots in the linked (or given) project")
        .option("-p, --project <id>", "List snapshots for this project instead of the linked one")
        .action(async (opts) => {
        const { projectId, scope } = await resolveProjectScope(opts.project);
        const snaps = await api.get(withScope(`/api/projects/${projectId}/snapshots`, scope));
        if (isJSONMode()) {
            printJSON(snaps);
            return;
        }
        if (!snaps.length) {
            console.log("No snapshots. Use `lizard sandbox snapshot <id>`.");
            return;
        }
        table(["Snapshot ID", "Name", "Template", "From", "CPU/Mem", "Created"], snaps.map((s) => [s.id, s.name ?? "", s.template, s.sourceSandboxId ?? "", `${s.cpus} vCPU / ${s.memoryMb} MB`, timeAgo(s.createdAt)]));
    });
    sb.command("restore")
        .alias("snapshot-fork")
        .argument("<snapshot-id>", "Snapshot ID to boot from")
        .description("Boot a new sandbox from a persistent snapshot")
        .option("--timeout <ms>", "Lifetime in milliseconds; 0 disables expiration", parseTimeoutOption, 0)
        .action(async (snapshotId, opts) => {
        const spinner = isJSONMode() ? null : ora(`Restoring from ${snapshotId}...`).start();
        let sandbox;
        try {
            sandbox = await api.post(`/api/sandbox-snapshots/${snapshotId}/fork`, { timeoutMs: opts.timeout });
        }
        catch (e) {
            spinner?.stop();
            throw e;
        }
        spinner?.stop();
        if (isJSONMode()) {
            printJSON(sandbox);
            return;
        }
        success(`Sandbox ${chalk.bold(sandbox.id)} restored from snapshot`);
        info(chalk.dim(`  Exec: lizard sandbox exec ${sandbox.id} -- <cmd>`));
    });
    sb.command("snapshot-rm")
        .alias("snapshot-delete")
        .argument("<snapshot-id>", "Snapshot ID")
        .description("Delete a persistent snapshot")
        .option("-y, --yes", "Skip confirmation")
        .action(async (snapshotId, opts) => {
        if (!opts.yes && isTTY() && !isJSONMode()) {
            const ok = await p.confirm({ message: `Delete snapshot ${chalk.bold(snapshotId)}?` });
            if (p.isCancel(ok) || !ok)
                process.exit(5);
        }
        await api.delete(`/api/sandbox-snapshots/${snapshotId}`);
        if (isJSONMode())
            printJSON({ id: snapshotId, status: "deleted" });
        else
            success(`Snapshot ${chalk.bold(snapshotId)} deleted`);
    });
    registerSandboxFiles(sb);
}
function registerSandboxFiles(sb) {
    const files = sb.command("files").description("Manage files inside a sandbox");
    files
        .command("ls")
        .argument("<id>", "Sandbox ID")
        .argument("[path]", "Directory to list", "/")
        .description("List a directory inside a sandbox")
        .action(async (id, path) => {
        const entries = await api.get(withQuery(`/api/sandboxes/${id}/files/list`, { path }));
        if (isJSONMode()) {
            printJSON(entries);
            return;
        }
        if (entries.length === 0) {
            console.log("(empty)");
            return;
        }
        table(["Type", "Name", "Size"], entries.map((e) => [e.type, e.name, e.type === "dir" ? "" : `${e.size}B`]));
    });
    files
        .command("cat")
        .argument("<id>", "Sandbox ID")
        .argument("<path>", "File path inside the sandbox")
        .description("Print a file from inside a sandbox")
        .action(async (id, path) => {
        const content = await getRawText(withQuery(`/api/sandboxes/${id}/files`, { path }));
        process.stdout.write(content);
    });
    files
        .command("put")
        .argument("<id>", "Sandbox ID")
        .argument("<local>", "Local file path")
        .argument("<remote>", "Destination path inside the sandbox")
        .description("Upload a local file into a sandbox")
        .action(async (id, local, remote) => {
        const content = fs.readFileSync(local, "utf-8");
        await api.post(`/api/sandboxes/${id}/files`, { path: remote, content });
        if (isJSONMode())
            printJSON({ id, path: remote, status: "written" });
        else
            success(`Wrote ${chalk.bold(remote)} in sandbox ${id}`);
    });
    files
        .command("get")
        .argument("<id>", "Sandbox ID")
        .argument("<remote>", "File path inside the sandbox")
        .argument("<local>", "Local destination path")
        .description("Download a file from a sandbox")
        .action(async (id, remote, local) => {
        const content = await getRawText(withQuery(`/api/sandboxes/${id}/files`, { path: remote }));
        fs.writeFileSync(local, content);
        if (isJSONMode())
            printJSON({ id, path: remote, local, status: "downloaded" });
        else
            success(`Downloaded ${chalk.bold(remote)} to ${local}`);
    });
    files
        .command("rm")
        .argument("<id>", "Sandbox ID")
        .argument("<path>", "Path inside the sandbox")
        .description("Delete a file or directory inside a sandbox")
        .action(async (id, path) => {
        await api.delete(`/api/sandboxes/${id}/files`, { path });
        if (isJSONMode())
            printJSON({ id, path, status: "deleted" });
        else
            success(`Deleted ${chalk.bold(path)} in sandbox ${id}`);
    });
}
/** Run a command inside a sandbox, streaming output. Resolves with the exit
 *  code: the remote command's code from the `exit` event, or 1 when the
 *  server reported an `error` event without one. Mirrors ssh.ts's parser. */
function execStream(sandboxId, cmd, onLine) {
    return new Promise((resolve, reject) => {
        let exitCode = null;
        let sawError = false;
        const baseURL = getBaseURL();
        const url = new URL(`${baseURL}/api/sandboxes/${sandboxId}/exec`);
        const token = getToken();
        const body = JSON.stringify({ cmd });
        const reqHeaders = {
            "Content-Type": "application/json",
            "Content-Length": String(Buffer.byteLength(body)),
            Accept: "text/event-stream",
        };
        if (token)
            reqHeaders["Authorization"] = `Bearer ${token}`;
        const transport = url.protocol === "https:" ? https : http;
        const req = transport.request({
            hostname: url.hostname,
            port: url.port || (url.protocol === "https:" ? 443 : 80),
            path: url.pathname,
            method: "POST",
            headers: reqHeaders,
        }, (res) => {
            if (res.statusCode && res.statusCode >= 400) {
                let errBody = "";
                res.on("data", (c) => (errBody += c.toString()));
                res.on("end", () => reject(new Error(`exec failed ${res.statusCode}: ${errBody}`)));
                return;
            }
            let buf = "";
            let currentEvent = "";
            res.setEncoding("utf8");
            res.on("data", (chunk) => {
                buf += chunk;
                const lines = buf.split("\n");
                buf = lines.pop() ?? "";
                for (const line of lines) {
                    const trimmed = line.replace(/\r$/, "");
                    if (trimmed === "") {
                        currentEvent = "";
                    }
                    else if (trimmed.startsWith("event:")) {
                        currentEvent = trimmed.slice(6).trim();
                    }
                    else if (trimmed.startsWith("data:")) {
                        const data = trimmed.slice(5).trimStart();
                        if (currentEvent === "exit") {
                            try {
                                exitCode = JSON.parse(data).exitCode ?? 0;
                            }
                            catch { }
                        }
                        else if (currentEvent === "error") {
                            sawError = true;
                            error(data);
                        }
                        else {
                            try {
                                const parsed = JSON.parse(data);
                                onLine(parsed.stream ?? "stdout", parsed.line ?? data);
                            }
                            catch {
                                onLine("stdout", data);
                            }
                        }
                    }
                }
            });
            res.on("end", () => resolve(exitCode ?? (sawError ? 1 : 0)));
            res.on("error", reject);
        });
        req.on("error", reject);
        req.write(body);
        req.end();
    });
}
/** POSIX single-quote escaping. Safe-token chars pass through verbatim;
 *  anything else gets wrapped in '…' with embedded `'` rewritten as `'\''`. */
function shellQuote(arg) {
    if (arg === "")
        return "''";
    if (/^[A-Za-z0-9_./:=@%+,-]+$/.test(arg))
        return arg;
    return "'" + arg.replace(/'/g, "'\\''") + "'";
}
//# sourceMappingURL=sandbox.js.map