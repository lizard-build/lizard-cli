import chalk from "chalk";
import * as p from "@clack/prompts";
import { api, getBaseURL, withScope } from "../lib/api.js";
import { resolveProjectScope, resolveService } from "../lib/resolve.js";
import { error, fail, isTTY, isJSONMode } from "../lib/format.js";
import { getToken } from "../lib/auth.js";
import * as https from "node:https";
import * as http from "node:http";
export function registerSSH(program) {
    program
        .command("ssh")
        .description("Execute a command inside a running service VM")
        .argument("[cmd...]", "Command and args to run inside the VM (required; pass after `--` to stop flag parsing, e.g. `-- ls -la /app`)")
        .option("-s, --service <id>", "Service name or ID")
        .option("-p, --project <id>", "Project name, slug, or ID")
        .addHelpText("after", `
Examples:
  lizard ssh -s my-app -- ls -la /app
  lizard ssh -s my-app -- printenv
  lizard ssh -s my-app -- bash -c "ps aux | head"`)
        .action(async (cmdArgs, opts) => {
        const { projectId, scope } = await resolveProjectScope(opts.project);
        let serviceId;
        if (opts.service) {
            // Resolve by name or ID through the shared resolver — guessing
            // "looks like an ID" by length breaks for long service names.
            const svc = await resolveService(projectId, opts.service);
            if (svc.kind !== "app") {
                fail(`"${svc.name}" is an addon — ssh works only for app services.`);
            }
            serviceId = svc.id;
        }
        else {
            // Resolve service interactively if not given
            const data = await api.get(withScope(`/api/projects/${projectId}/services`, scope));
            const running = (data.apps || []).filter((a) => a.status === "running");
            if (running.length === 0) {
                fail("No running services in this project.");
            }
            if (running.length === 1) {
                serviceId = running[0].id;
            }
            else if (isTTY()) {
                const selected = await p.select({
                    message: "Select a service",
                    options: running.map((a) => ({ value: a.id, label: a.name || a.id, hint: a.status })),
                });
                if (p.isCancel(selected))
                    process.exit(5);
                serviceId = selected;
            }
            else {
                fail("Multiple services — pass -s <service>");
            }
        }
        if (cmdArgs.length === 0) {
            fail("No command given. Usage: lizard ssh -s <service> -- <cmd> [args...]");
        }
        // The server executes `cmd` via shell on the VM, so each arg must be
        // shell-quoted before being joined — otherwise `bash -c "ps | head"`
        // collapses to `bash -c ps | head` (quotes lost, `|` becomes a real pipe).
        const cmd = cmdArgs.map(shellQuote).join(" ");
        // The `$ cmd` echo is a human nicety — keep stdout pure passthrough
        // for machine consumers (--json / piped output).
        if (!isJSONMode()) {
            process.stdout.write(chalk.dim(`$ ${cmd}\n`));
        }
        const exitCode = await execStream(serviceId, cmd, (stream, line) => {
            if (stream === "stderr") {
                process.stderr.write(line + "\n");
            }
            else {
                process.stdout.write(line + "\n");
            }
        });
        process.exit(exitCode);
    });
}
/** Run a command on the VM, streaming output. Resolves with the exit code:
 *  the remote command's code from the `exit` event, or 1 when the server
 *  reported an `error` event without one. */
function execStream(appId, cmd, onLine) {
    return new Promise((resolve, reject) => {
        let exitCode = null;
        let sawError = false;
        const baseURL = getBaseURL();
        const url = new URL(`${baseURL}/api/apps/${appId}/exec`);
        const token = getToken();
        const body = JSON.stringify({ cmd });
        const reqHeaders = {
            "Content-Type": "application/json",
            "Content-Length": String(Buffer.byteLength(body)),
            "Accept": "text/event-stream",
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
                let body = "";
                res.on("data", (c) => (body += c.toString()));
                res.on("end", () => reject(new Error(`exec failed ${res.statusCode}: ${body}`)));
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
//# sourceMappingURL=ssh.js.map