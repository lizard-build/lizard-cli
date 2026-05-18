import chalk from "chalk";
import * as p from "@clack/prompts";
import { Command } from "commander";
import { api, getBaseURL, streamSSE } from "../lib/api.js";
import { resolveProjectId } from "../lib/config.js";
import { error, isTTY } from "../lib/format.js";
import { getToken } from "../lib/auth.js";
import * as https from "node:https";
import * as http from "node:http";

export function registerSSH(program: Command) {
  program
    .command("ssh [cmd...]")
    .description("Execute a command inside a running service VM")
    .option("-s, --service <id>", "Service name or ID")
    .option("-p, --project <id>", "Project name or ID")
    .addHelpText("after", `
Examples:
  lizard ssh -s my-app -- ls -la /app
  lizard ssh -s my-app -- printenv
  lizard ssh -s my-app -- bash -c "ps aux | head"`)
    .action(async (cmdArgs: string[], opts) => {
      const projectId = await resolveProjectId(opts.project);
      let serviceId = opts.service as string | undefined;

      // Resolve service interactively if not given
      if (!serviceId) {
        const data = await api.get<{ apps: Array<{ id: string; name: string; status: string }> }>(
          `/api/projects/${projectId}/services`,
        );
        const running = (data.apps || []).filter((a) => a.status === "running");
        if (running.length === 0) {
          error("No running services in this project.");
          process.exit(1);
        }
        if (running.length === 1) {
          serviceId = running[0].id;
        } else if (isTTY()) {
          const selected = await p.select({
            message: "Select a service",
            options: running.map((a) => ({ value: a.id, label: a.name || a.id, hint: a.status })),
          });
          if (p.isCancel(selected)) process.exit(5);
          serviceId = selected as string;
        } else {
          error("Multiple services — pass -s <service>");
          process.exit(1);
        }
      }

      // Resolve service ID if a name was given (lookup by name)
      if (serviceId && !serviceId.match(/^[A-Za-z0-9_-]{20,}$/)) {
        const data = await api.get<{ apps: Array<{ id: string; name: string; serviceName?: string }> }>(
          `/api/projects/${projectId}/services`,
        );
        const match = (data.apps || []).find(
          (a) => a.name === serviceId || a.serviceName === serviceId || a.id === serviceId,
        );
        if (match) serviceId = match.id;
      }

      if (cmdArgs.length === 0) {
        error("No command given. Usage: lizard ssh -s <service> -- <cmd> [args...]");
        process.exit(1);
      }

      const cmd = cmdArgs.join(" ");
      process.stdout.write(chalk.dim(`$ ${cmd}\n`));

      let exitCode = 0;

      await execStream(serviceId!, cmd, (stream, line) => {
        if (stream === "stderr") {
          process.stderr.write(line + "\n");
        } else {
          process.stdout.write(line + "\n");
        }
      }, (code) => {
        exitCode = code;
      });

      process.exit(exitCode);
    });
}

function execStream(
  appId: string,
  cmd: string,
  onLine: (stream: string, line: string) => void,
  onExit: (code: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const baseURL = getBaseURL();
    const url = new URL(`${baseURL}/api/apps/${appId}/exec`);
    const token = getToken();
    const body = JSON.stringify({ cmd });

    const reqHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      "Content-Length": String(Buffer.byteLength(body)),
      "Accept": "text/event-stream",
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
          let body = "";
          res.on("data", (c: Buffer) => (body += c.toString()));
          res.on("end", () => reject(new Error(`exec failed ${res.statusCode}: ${body}`)));
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
                try { onExit(JSON.parse(data).exitCode ?? 0); } catch {}
              } else if (currentEvent === "error") {
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

        res.on("end", resolve);
        res.on("error", reject);
      },
    );

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}
