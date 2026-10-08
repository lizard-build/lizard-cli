import chalk from "chalk";
import ora from "ora";
import fs from "node:fs";
import * as https from "node:https";
import * as http from "node:http";
import * as p from "@clack/prompts";
import { Option } from "commander";
import open from "open";
import { api, APIError, getBaseURL, getRawBytes, apiErrorFrom, clientHeaders, getRequestToken, withQuery, withScope } from "../lib/api.js";
import { getToken } from "../lib/auth.js";
import { resolveProjectScope } from "../lib/resolve.js";
import { resolveProjectId } from "../lib/config.js";
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
const TEMPLATE_HINT = "base, codex, interpreter, desktop";
// The three machines a sandbox can be, each priced per hour, billed per second by the server. The
// platform rejects anything else, so the CLI offers exactly these.
const SANDBOX_SIZES = ["small", "medium", "large"];
const SIZE_HINT = "small 2 vCPU/4 GB, medium 4/8, large 8/16";
function parseIntOption(v) {
    const n = Number(v);
    if (!/^\d+$/.test(v) || !Number.isSafeInteger(n) || n < 1 || n > 65535) {
        throw new Error("Port must be an integer between 1 and 65535");
    }
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
    table(["ID", "Template", "Status", "Region", "Size", "CPU/Mem", "Created"], sandboxes.map((s) => [
        s.id,
        s.template,
        statusColor(s.status),
        s.region,
        s.size ?? "-",
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
        .addOption(new Option("-s, --size <size>", `Machine size (${SIZE_HINT}); default medium`).choices(SANDBOX_SIZES))
        .option("--timeout <ms>", "Lifetime in milliseconds; 0 disables expiration", parseTimeoutOption, 300_000)
        .option("--region <code>", "Region to create the sandbox in")
        .option("--snapshot <id>", "Create from a private saved snapshot (runs on the machine it was captured on)")
        .option("--volume <name-or-id>", "Attach a persistent volume")
        .option("--with-token [key]", "Install this liz_ key inside the sandbox so `lizard` works there (defaults to the key you are using)")
        .option("-p, --project <id>", "Project to create the sandbox in (name, slug, or ID). Defaults to the linked project.")
        .action(async (opts) => {
        // A snapshot restores onto the machine it was captured on, so the server ignores a
        // size alongside it. Say so rather than quietly creating something other than asked.
        if (opts.size && opts.snapshot) {
            throw new Error("--size can't be combined with --snapshot: a snapshot runs on the machine it was captured on.");
        }
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
            // --with-token seeds ~/.lizard/config.json inside the sandbox, so `lizard` works
            // there. Bare --with-token reuses the key this command is authenticating with.
            //
            // Anything in the sandbox can read that key and sandboxes run untrusted code, so
            // a full-access key here hands the sandbox your whole account. Scopes are
            // enforced end to end now, so a workspace-scoped key is bounded to that one
            // workspace if it escapes — warn rather than silently do the dangerous thing.
            let lizardToken;
            if (opts.withToken) {
                lizardToken = typeof opts.withToken === "string" ? opts.withToken : (getToken() ?? undefined);
                if (!lizardToken)
                    throw new Error("--with-token: no API key available. Pass one explicitly, or `lizard login` first.");
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
        const machine = `${sandbox.cpus} vCPU / ${sandbox.memoryMb} MB`;
        info(chalk.dim(sandbox.size
            ? `  Size: ${sandbox.size} (${machine})${sandbox.pricePerHour != null ? `, $${sandbox.pricePerHour}/h` : ""}`
            : `  Machine: ${machine}`));
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
    registerSandboxAgentCommands(sb);
    sb.command("ssh")
        .alias("shell")
        .argument("<id>", "Sandbox ID")
        .description("Open an interactive shell in a running sandbox")
        .addHelpText("after", `
Works for every running sandbox with no keys to set up: it uses your Lizard login,
and a scoped API key only reaches sandboxes in its scope. Ctrl-C, arrows and tab
completion go to the sandbox; type \`exit\` or press Ctrl-D to leave.

To run one command non-interactively, use \`lizard sandbox exec <id> -- <cmd>\`.

Example:
  lizard sandbox ssh sb_abc123`)
        .action(async (id) => {
        process.exit(await sandboxShell(id));
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
    sb.command("desktop")
        .argument("<id>", "Sandbox ID (created with `-t desktop`)")
        .description("Start a sandbox's graphical desktop and print its browser URL")
        .option("--view-only", "Print/open only the view-only URL (watch, no control)")
        .option("--resolution <WxH>", "Screen size, e.g. 1920x1080 (640-3840 x 480-2160)", parseResolution)
        .option("--open", "Open the desktop in your default browser")
        .option("--status", "Show the desktop's state and URLs without starting it")
        .option("--stop", "Stop the desktop and unpublish its port")
        .addHelpText("after", `
Examples:
  lizard sandbox create -t desktop
  lizard sandbox desktop sb_abc123 --open
  lizard sandbox desktop sb_abc123 --resolution 1920x1080
  lizard sandbox desktop sb_abc123 --stop`)
        .action(async (id, opts) => {
        if (opts.stop && opts.status)
            throw new Error("--stop and --status can't be combined.");
        if (opts.resolution && (opts.stop || opts.status)) {
            throw new Error("--resolution only applies when starting the desktop; drop --stop/--status.");
        }
        if (opts.open && opts.stop)
            throw new Error("--open can't be combined with --stop.");
        const path = `/api/sandboxes/${id}/desktop`;
        const label = opts.stop ? "Stopping desktop..." : opts.status ? "Checking desktop..." : "Starting desktop...";
        const spinner = isJSONMode() ? null : ora(label).start();
        let result;
        try {
            if (opts.stop)
                result = await api.delete(path);
            else if (opts.status)
                result = await api.get(path);
            else
                result = await api.post(path, opts.resolution ?? {});
        }
        catch (e) {
            spinner?.stop();
            if (e instanceof APIError && e.code === "DESKTOP_NOT_SUPPORTED") {
                throw new APIError(e.status, `${e.message}\nSandbox ${id} has no desktop. Create one with: lizard sandbox create -t desktop`, e.code, e.body);
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
        }
        else {
            info(`  ${chalk.cyan(result.url)}`);
            info(chalk.dim(`  View only: ${result.viewOnlyUrl}`));
        }
        info(chalk.yellow(opts.viewOnly
            ? "  This link shows the sandbox's screen; treat it like a password."
            : "  This link grants control of the sandbox; treat it like a password."));
        if (opts.open && target) {
            await open(target).catch(() => { });
            info(chalk.dim("  Opened in browser"));
        }
    });
    sb.command("vnc")
        .argument("<id>", "Sandbox ID (created with `-t desktop`)")
        .description("Connect a VNC app (Screen Sharing, TigerVNC, RealVNC) to a sandbox's desktop")
        .option("--port <port>", "Local port to listen on (the next free one is used if taken)", parseIntOption, 5900)
        .option("--view-only", "Use the view-only password: watch, no control")
        .option("--open", "Open the address in your VNC app (vnc:// — Screen Sharing on macOS)")
        .addHelpText("after", `
The desktop has no public VNC port. This listens on localhost and tunnels each
connection over the desktop's secured WebSocket, so point any VNC app at the
address it prints and enter the password. Runs until Ctrl-C.

Examples:
  lizard sandbox vnc sb_abc123            # then connect your VNC app to localhost:5900
  lizard sandbox vnc sb_abc123 --open     # macOS: opens Screen Sharing
  lizard sandbox vnc sb_abc123 --view-only`)
        .action(async (id, opts) => {
        const spinner = isJSONMode() ? null : ora("Starting desktop...").start();
        let result;
        try {
            result = await api.post(`/api/sandboxes/${id}/desktop`, {});
        }
        catch (e) {
            spinner?.stop();
            if (e instanceof APIError && e.code === "DESKTOP_NOT_SUPPORTED") {
                throw new APIError(e.status, `${e.message}\nCreate a desktop sandbox with: lizard sandbox create -t desktop`, e.code, e.body);
            }
            throw e;
        }
        spinner?.stop();
        const desktopUrl = opts.viewOnly ? result.viewOnlyUrl : result.url;
        if (!result.running || !desktopUrl)
            throw new Error(`The desktop on sandbox ${id} did not start.`);
        const { wsUrl, password, headers } = vncTarget(desktopUrl);
        const tunnel = await startVncTunnel(wsUrl, opts.port, {
            onConnect: () => { if (!isJSONMode())
                info(chalk.dim(`  VNC app connected`)); },
            onClose: (reason) => { if (!isJSONMode())
                info(chalk.dim(`  VNC app session ended: ${reason}`)); },
        }, headers);
        const address = `localhost:${tunnel.port}`;
        if (isJSONMode()) {
            printJSON({ id, address, host: "127.0.0.1", port: tunnel.port, password, viewOnly: !!opts.viewOnly });
        }
        else {
            success(`VNC ready for sandbox ${chalk.bold(id)}${opts.viewOnly ? " (view only)" : ""}`);
            info(`  Address:  ${chalk.cyan(address)}`);
            info(`  Password: ${chalk.cyan(password)}`);
            info(chalk.dim(`  Connect any VNC app to the address above; on macOS: open vnc://${address}`));
            info(chalk.dim("  Ctrl-C to stop"));
        }
        if (opts.open) {
            // Screen Sharing takes the password from the URL, so it connects without a prompt.
            await open(`vnc://:${encodeURIComponent(password)}@${address}`).catch(() => { });
        }
        await new Promise((resolve) => {
            const stop = () => { tunnel.close(); resolve(); };
            process.once("SIGINT", stop);
            process.once("SIGTERM", stop);
        });
    });
    sb.command("snapshot")
        .argument("<id>", "Running sandbox ID")
        .requiredOption("--name <name>", "Name for this private project snapshot")
        .option("--warm <count>", "Copies to keep ready (1–10)", parseWarmCount, 5)
        .option("--no-wait", "Return once capture is queued")
        .description("Save a running sandbox and keep five copies warm by default")
        .action(async (id, opts) => {
        let snapshot = await api.post(`/api/sandboxes/${id}/snapshot`, { name: opts.name, poolSize: opts.warm });
        if (opts.wait)
            snapshot = await waitForSnapshot(snapshot.id);
        if (isJSONMode())
            printJSON(snapshot);
        else {
            success(`Snapshot ${chalk.bold(snapshot.id)}: ${snapshot.status}`);
            info(`Warm copies: ${snapshot.readyCount}/${snapshot.poolSize}`);
        }
    });
    for (const operation of ["pause", "resume"]) {
        sb.command(operation)
            .argument("<id>", "Sandbox ID")
            .option("--no-wait", "Return once the operation is queued")
            .description(operation === "pause" ? "Save running state with CRIU and stop the sandbox" : "Restore a paused sandbox with its saved memory and files")
            .action(async (id, opts) => {
            const queued = await api.post(`/api/sandboxes/${id}/${operation}`, {});
            if (opts.wait && operation === 'pause' && queued.snapshotId)
                await waitForSnapshot(queued.snapshotId);
            const result = opts.wait ? await waitForSandbox(id, operation === "pause" ? "paused" : "running") : queued;
            if (isJSONMode())
                printJSON(result);
            else
                success(`Sandbox ${chalk.bold(id)}: ${result.status}`);
        });
    }
    sb.command("restore")
        .argument("<snapshot-id>", "Saved snapshot ID")
        .option("--timeout <ms>", "Lifetime in milliseconds; 0 disables expiration", parseTimeoutOption, 300_000)
        .description("Start a new sandbox from a private warm snapshot")
        .action(async (snapshotId, opts) => {
        const snapshot = await api.get(`/api/sandbox-snapshots/${snapshotId}`);
        const sandbox = await api.post("/api/sandboxes", { snapshotId, projectId: snapshot.projectId, region: snapshot.region, timeoutMs: opts.timeout });
        if (isJSONMode())
            printJSON(sandbox);
        else
            success(`Sandbox ${chalk.bold(sandbox.id)} created from ${snapshot.name}`);
    });
    for (const operation of ["pause", "resume"]) {
        sb.command(`snapshot-${operation}`)
            .argument("<snapshot-id>", "Saved snapshot ID")
            .description(operation === "pause" ? "Release a snapshot's warm copies and keep its saved state" : "Refill a paused snapshot's warm pool")
            .action(async (id) => {
            const snapshot = await api.post(`/api/sandbox-snapshots/${id}/${operation}`, {});
            if (isJSONMode())
                printJSON(snapshot);
            else
                success(`Snapshot ${chalk.bold(id)}: ${snapshot.status}`);
        });
    }
    sb.command("snapshot-warm")
        .argument("<snapshot-id>", "Saved snapshot ID")
        .argument("<count>", "Copies to keep ready (1–10)", parseWarmCount)
        .description("Change a snapshot's warm pool size")
        .action(async (id, count) => {
        const snapshot = await api.patch(`/api/sandbox-snapshots/${id}`, { poolSize: count });
        if (isJSONMode())
            printJSON(snapshot);
        else
            success(`Snapshot ${chalk.bold(id)} will keep ${count} copies warm`);
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
            console.log("No snapshots.");
            return;
        }
        table(["Snapshot ID", "Name", "Template", "From", "CPU/Mem", "Created"], snaps.map((s) => [s.id, s.name ?? "", s.template, s.sourceSandboxId ?? "", `${s.cpus} vCPU / ${s.memoryMb} MB`, timeAgo(s.createdAt)]));
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
        const content = await getRawBytes(withQuery(`/api/sandboxes/${id}/files`, { path }));
        process.stdout.write(content);
    });
    files
        .command("put")
        .argument("<id>", "Sandbox ID")
        .argument("<local>", "Local file path")
        .argument("<remote>", "Destination path inside the sandbox")
        .description("Upload a local file into a sandbox")
        .action(async (id, local, remote) => {
        const content = fs.readFileSync(local).toString("base64");
        await api.post(`/api/sandboxes/${id}/files`, { path: remote, content, encoding: "base64" });
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
        const content = await getRawBytes(withQuery(`/api/sandboxes/${id}/files`, { path: remote }));
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
export function execStream(sandboxId, cmd, onLine) {
    return new Promise((resolve, reject) => {
        let exitCode = null;
        let sawError = false;
        const baseURL = getBaseURL();
        const url = new URL(`${baseURL}/api/sandboxes/${sandboxId}/exec`);
        const token = getRequestToken();
        const body = JSON.stringify({ cmd });
        const reqHeaders = {
            ...clientHeaders(),
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
            path: url.pathname + url.search,
            method: "POST",
            headers: reqHeaders,
        }, (res) => {
            res.on("error", reject);
            if (res.statusCode && res.statusCode >= 400) {
                let errBody = "";
                res.on("data", (c) => (errBody += c.toString()));
                res.on("end", () => {
                    let body = null;
                    try {
                        body = JSON.parse(errBody);
                    }
                    catch { }
                    reject(apiErrorFrom(res.statusCode, res.statusMessage || "Exec failed", body));
                });
                return;
            }
            let buf = "";
            let currentEvent = "";
            let dataLines = [];
            const dispatch = () => {
                if (!dataLines.length) {
                    currentEvent = "";
                    return;
                }
                const data = dataLines.join("\n");
                if (currentEvent === "exit") {
                    try {
                        const code = JSON.parse(data).exitCode;
                        if (!Number.isInteger(code) || code < 0 || code > 255) {
                            throw new Error("Invalid exec exit code");
                        }
                        exitCode = code;
                    }
                    catch {
                        reject(new Error("Invalid exec exit event"));
                    }
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
                currentEvent = "";
                dataLines = [];
            };
            const line = (value) => {
                const trimmed = value.replace(/\r$/, "");
                if (!trimmed)
                    dispatch();
                else if (trimmed.startsWith("event:"))
                    currentEvent = trimmed.slice(6).trim();
                else if (trimmed.startsWith("data:"))
                    dataLines.push(trimmed.slice(5).replace(/^ /, ""));
            };
            res.setEncoding("utf8");
            res.on("data", (chunk) => {
                buf += chunk;
                const lines = buf.split("\n");
                buf = lines.pop() ?? "";
                for (const value of lines)
                    line(value);
            });
            res.on("end", () => {
                if (buf)
                    line(buf);
                dispatch();
                if (sawError && (exitCode === null || exitCode === 0)) {
                    resolve(1);
                    return;
                }
                if (exitCode === null) {
                    reject(new APIError(502, "Exec stream ended without an exit event", "EXEC_STREAM_INCOMPLETE"));
                    return;
                }
                resolve(exitCode);
            });
        });
        req.on("error", (err) => {
            reject(err.code === "ETIMEDOUT" ? new APIError(408, "Exec request timed out") : err);
        });
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
/** Parse `WxH` (e.g. 1920x1080) and check the bounds the server enforces, so a typo
 *  fails before a round trip that would start the desktop at the wrong size. */
export function parseResolution(value) {
    const m = /^(\d+)[xX](\d+)$/.exec(value.trim());
    if (!m)
        throw new Error(`Invalid resolution "${value}": use WxH, e.g. 1920x1080`);
    const width = Number(m[1]);
    const height = Number(m[2]);
    if (width < 640 || width > 3840)
        throw new Error(`Resolution width must be 640-3840 (got ${width})`);
    if (height < 480 || height > 2160)
        throw new Error(`Resolution height must be 480-2160 (got ${height})`);
    return { width, height };
}
function parseWarmCount(value) {
    if (!/^[0-9]+$/.test(value) || Number(value) < 1 || Number(value) > 10)
        throw new Error("Warm copies must be an integer between 1 and 10");
    return Number(value);
}
async function waitForSnapshot(id) {
    const deadline = Date.now() + 20 * 60_000;
    while (Date.now() < deadline) {
        const snapshot = await api.get(`/api/sandbox-snapshots/${id}`);
        if (snapshot.status === "failed")
            throw new Error(snapshot.error || "Snapshot capture failed");
        if (snapshot.status === "ready")
            return snapshot;
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    throw new Error(`Snapshot is still processing. Check it with lizard sandbox snapshots.`);
}
async function waitForSandbox(id, target) {
    const deadline = Date.now() + 5 * 60_000;
    while (Date.now() < deadline) {
        const sandbox = await api.get(`/api/sandboxes/${id}`);
        if (sandbox.status === target)
            return sandbox;
        if (!["running", "pausing", "paused", "resuming"].includes(sandbox.status))
            throw new Error(`Sandbox ${id} is ${sandbox.status}`);
        if (target === 'running' && sandbox.status === 'paused')
            throw new Error('Resume failed; the saved checkpoint is retained. Retry resume.');
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    throw new Error(`Sandbox ${id} is still processing; check its status.`);
}
//# sourceMappingURL=sandbox.js.map