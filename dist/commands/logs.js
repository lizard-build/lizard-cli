import chalk from "chalk";
import * as p from "@clack/prompts";
import { streamSSE, api } from "../lib/api.js";
import { resolveProjectId } from "../lib/config.js";
import { info, error, isTTY } from "../lib/format.js";
export function registerLogs(program) {
    program
        .command("logs")
        .description("Stream runtime logs")
        .option("--build", "Show build logs instead of runtime")
        .option("--service <id>", "Only show logs for a specific service")
        .option("-p, --project <id>", "Project name or ID")
        .option("--tail <n>", "Print last N log lines and exit (no follow)")
        .action(async (opts) => {
        const projectId = await resolveProjectId(opts.project);
        const tailN = opts.tail !== undefined ? parseTail(opts.tail) : undefined;
        if (opts.build) {
            await showBuildLogs(opts.service, projectId, tailN);
            return;
        }
        // --tail: fetch historical logs and exit
        if (tailN !== undefined) {
            const params = new URLSearchParams({ limit: String(tailN) });
            if (opts.service)
                params.set("service", opts.service);
            const entries = await api.get(`/api/projects/${projectId}/logs?${params}`);
            for (const e of entries)
                printLogEntry(e);
            return;
        }
        let serviceId = opts.service;
        if (!serviceId && isTTY()) {
            // Offer to pick a specific service or stream all
            const data = await api.get(`/api/projects/${projectId}/services`);
            const apps = data.apps || [];
            if (apps.length > 1) {
                const choices = [
                    { value: "all", label: "All services", hint: "stream combined logs" },
                    ...apps.map((a) => ({
                        value: a.id,
                        label: a.name || a.id,
                        hint: a.status,
                    })),
                ];
                const selected = await p.select({ message: "Show logs for", options: choices });
                if (p.isCancel(selected))
                    process.exit(5);
                if (selected !== "all")
                    serviceId = selected;
            }
        }
        if (serviceId) {
            // Stream logs for a specific app
            info(chalk.dim("Streaming logs... (Ctrl+C to stop)\n"));
            await streamSSE(`/api/apps/${serviceId}/logs`, (event, data) => {
                if (event === "error") {
                    error(data);
                    return false;
                }
                printLogLine(data);
                return true;
            });
            return;
        }
        // Stream all project logs
        info(chalk.dim("Streaming project logs... (Ctrl+C to stop)\n"));
        await streamSSE(`/api/projects/${projectId}/logs/stream`, (event, data) => {
            if (event === "error") {
                error(data);
                return false;
            }
            printLogLine(data);
            return true;
        });
    });
}
function parseTail(raw) {
    const n = parseInt(raw, 10);
    if (isNaN(n) || n < 1) {
        error("--tail must be a positive integer");
        process.exit(1);
    }
    if (n > 1000) {
        info(chalk.yellow("--tail capped at 1000 (server limit)"));
        return 1000;
    }
    return n;
}
function replicaPrefix(e) {
    if (!e.replica)
        return "";
    return chalk.magenta(`[${e.replica}]`) + " ";
}
function printLogEntry(e) {
    const rep = replicaPrefix(e);
    if (e.service && e.message) {
        const prefix = chalk.cyan(`[${e.service}]`);
        process.stdout.write(`${prefix} ${rep}${e.message}\n`);
    }
    else if (e.message) {
        process.stdout.write(`${rep}${e.message}\n`);
    }
}
function printLogLine(data) {
    try {
        const parsed = JSON.parse(data);
        const rep = replicaPrefix(parsed);
        if (parsed.service && parsed.message) {
            const prefix = chalk.cyan(`[${parsed.service}]`);
            process.stdout.write(`${prefix} ${rep}${parsed.message}\n`);
        }
        else if (parsed.message) {
            process.stdout.write(`${rep}${parsed.message}\n`);
        }
        else if (typeof parsed === "string") {
            process.stdout.write(parsed + "\n");
        }
        else {
            process.stdout.write(data + "\n");
        }
    }
    catch {
        process.stdout.write(data + "\n");
    }
}
async function showBuildLogs(serviceId, projectId, tailN) {
    let appId = serviceId;
    if (!appId) {
        // Get first app in project
        const data = await api.get(`/api/projects/${projectId}/services`);
        if (!data.apps?.length) {
            throw new Error("No apps in project");
        }
        appId = data.apps[0].id;
    }
    // Get latest build
    const app = await api.get(`/api/apps/${appId}`);
    if (!app.builds?.length) {
        throw new Error("No builds found");
    }
    const buildId = app.builds[0].id;
    info(chalk.dim(`Build ${buildId}\n`));
    if (tailN !== undefined) {
        const lines = [];
        await streamSSE(`/api/builds/${buildId}/logs`, (event, data) => {
            if (event === "done" || event === "error")
                return false;
            lines.push(data);
            return true;
        });
        for (const line of lines.slice(-tailN))
            printLogLine(line);
        return;
    }
    await streamSSE(`/api/builds/${buildId}/logs`, (event, data) => {
        if (event === "done" || event === "error") {
            return false;
        }
        printLogLine(data);
        return true;
    });
}
//# sourceMappingURL=logs.js.map