import chalk from "chalk";
import * as p from "@clack/prompts";
import { streamSSE, api, withScope, withQuery } from "../lib/api.js";
import { resolveProjectScope, resolveService, getActiveService } from "../lib/resolve.js";
import { info, error, isTTY, isJSONMode, printJSON, table, statusColor, timeAgo } from "../lib/format.js";
export function registerLogs(program) {
    program
        .command("logs")
        .description("Stream runtime logs")
        .option("--build", "Show build logs instead of runtime")
        .option("-s, --service <id>", "Only show logs for a specific service")
        .option("-p, --project <id>", "Project name, slug, or ID")
        .option("--tail <n>", "Print last N log lines and exit (no follow)")
        .option("--restarts [n]", "List last N restart events (default 20) and exit")
        .option("--restart <id>", "Print log tail of a specific restart event (or 'latest')")
        .action(async (opts) => {
        if (opts.restarts !== undefined && opts.restart !== undefined) {
            error("Use --restarts (list) or --restart <id> (detail), not both");
            process.exit(1);
        }
        const { projectId, scope } = await resolveProjectScope(opts.project);
        if (opts.restarts !== undefined) {
            await showRestartList(opts.service, projectId, parseRestartsN(opts.restarts));
            return;
        }
        if (opts.restart !== undefined) {
            await showRestartLogTail(opts.service, projectId, String(opts.restart));
            return;
        }
        // In JSON mode default to a historical tail so non-interactive callers
        // (agents, pipes) get a snapshot and exit instead of hanging on SSE.
        const tailN = opts.tail !== undefined
            ? parseTail(opts.tail)
            : isJSONMode()
                ? 200
                : undefined;
        if (opts.build) {
            await showBuildLogs(opts.service, projectId, scope, tailN);
            return;
        }
        // Resolve -s flag (may be name, slug, or ID) once up front so every
        // branch below talks to the API with a real service ID.
        let serviceId;
        if (opts.service) {
            const svc = await resolveService(projectId, opts.service);
            serviceId = svc.id;
        }
        // --tail: fetch historical logs and exit
        if (tailN !== undefined) {
            const entries = await api.get(withScope(withQuery(`/api/projects/${projectId}/logs`, {
                limit: tailN,
                service: serviceId,
            }), scope));
            for (const e of entries)
                printLogEntry(e);
            return;
        }
        if (!serviceId && isTTY() && !isJSONMode()) {
            // Offer to pick a specific service or stream all
            const data = await api.get(withScope(`/api/projects/${projectId}/services`, scope));
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
        await streamSSE(withScope(`/api/projects/${projectId}/logs/stream`, scope), (event, data) => {
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
function parseRestartsN(raw) {
    if (raw === true || raw === "" || raw === undefined)
        return 20;
    const n = parseInt(String(raw), 10);
    if (isNaN(n) || n < 1) {
        error("--restarts must be a positive integer");
        process.exit(1);
    }
    return n;
}
async function fetchFlatRestarts(appId) {
    const builds = await api.get(`/api/apps/${appId}/deploy-events`);
    const flat = [];
    for (const b of builds) {
        for (const e of b.events) {
            flat.push({ ...e, buildId: b.buildId, commitSha: b.commitSha });
        }
    }
    flat.sort((a, b) => b.crashedAt - a.crashedAt);
    return flat;
}
function replicaPrefix(e) {
    if (!e.replica)
        return "";
    return chalk.magenta(`[${e.replica}]`) + " ";
}
function printLogEntry(e) {
    if (isJSONMode()) {
        process.stdout.write(JSON.stringify(e) + "\n");
        return;
    }
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
    let parsed;
    try {
        parsed = JSON.parse(data);
    }
    catch {
        parsed = { message: data };
    }
    if (typeof parsed === "string")
        parsed = { message: parsed };
    if (isJSONMode()) {
        process.stdout.write(JSON.stringify(parsed) + "\n");
        return;
    }
    const rep = replicaPrefix(parsed);
    if (parsed.service && parsed.message) {
        const prefix = chalk.cyan(`[${parsed.service}]`);
        process.stdout.write(`${prefix} ${rep}${parsed.message}\n`);
    }
    else if (parsed.message) {
        process.stdout.write(`${rep}${parsed.message}\n`);
    }
    else {
        process.stdout.write(data + "\n");
    }
}
async function showRestartList(serviceRef, projectId, n) {
    const svc = await getActiveService(serviceRef, projectId);
    const events = await fetchFlatRestarts(svc.id);
    const slice = events.slice(0, n);
    if (isJSONMode()) {
        for (const e of slice) {
            process.stdout.write(JSON.stringify(e) + "\n");
        }
        return;
    }
    if (slice.length === 0) {
        info(chalk.dim(`No restart events for ${svc.name}.`));
        return;
    }
    table(["When", "Source", "Status", "Exit", "By", "ID"], slice.map((e) => [
        timeAgo(e.crashedAt),
        e.source,
        statusColor(e.status),
        (e.exitInfo ?? "").slice(0, 60),
        e.triggeredBy ?? chalk.dim("—"),
        chalk.dim(e.id),
    ]));
    if (events.length > slice.length) {
        info(chalk.dim(`\n(${events.length - slice.length} more — re-run with --restarts ${events.length})`));
    }
    info(chalk.dim("\nInspect: lizard logs --restart <id>   (or 'latest')"));
}
async function showRestartLogTail(serviceRef, projectId, ref) {
    const svc = await getActiveService(serviceRef, projectId);
    const events = await fetchFlatRestarts(svc.id);
    let evt;
    if (ref === "latest") {
        evt = events[0];
        if (!evt) {
            error(`No restart events for ${svc.name}.`);
            process.exit(1);
        }
    }
    else {
        evt = events.find((e) => e.id === ref);
        if (!evt) {
            error(`Restart event "${ref}" not found for ${svc.name}.`);
            process.exit(1);
        }
    }
    if (isJSONMode()) {
        printJSON(evt);
        return;
    }
    console.log(chalk.dim("Event:    ") + evt.id);
    console.log(chalk.dim("When:     ") + timeAgo(evt.crashedAt));
    console.log(chalk.dim("Source:   ") + evt.source);
    console.log(chalk.dim("Status:   ") + statusColor(evt.status));
    if (evt.exitInfo)
        console.log(chalk.dim("Exit:     ") + evt.exitInfo);
    if (evt.triggeredBy)
        console.log(chalk.dim("By:       ") + evt.triggeredBy);
    if (evt.buildId)
        console.log(chalk.dim("Build:    ") + evt.buildId);
    console.log();
    if (evt.logsTail) {
        process.stdout.write(evt.logsTail);
        if (!evt.logsTail.endsWith("\n"))
            process.stdout.write("\n");
    }
    else {
        info(chalk.dim(`<no log tail captured — source=${evt.source} (manual restarts don't capture logs)>`));
    }
}
async function showBuildLogs(serviceRef, projectId, scope, tailN) {
    let appId;
    if (serviceRef) {
        const svc = await resolveService(projectId, serviceRef);
        appId = svc.id;
    }
    if (!appId) {
        // Get first app in project
        const data = await api.get(withScope(`/api/projects/${projectId}/services`, scope));
        if (!data.apps?.length) {
            throw new Error("No apps in project. Create one with `lizard up` or `lizard add`.");
        }
        appId = data.apps[0].id;
    }
    // Get latest build
    const app = await api.get(`/api/apps/${appId}`);
    if (!app.builds?.length) {
        throw new Error("No builds for this app yet. Trigger one with `lizard up` or `lizard redeploy`.");
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