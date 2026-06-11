import chalk from "chalk";
import * as p from "@clack/prompts";
import { streamSSE, api, withScope, withQuery } from "../lib/api.js";
import { resolveProjectScope, resolveService, getActiveServiceWithKind } from "../lib/resolve.js";
import { getProjectLink } from "../lib/config.js";
import { info, error, warn, isTTY, isJSONMode, printJSON, table, statusColor, timeAgo } from "../lib/format.js";
// Levels assigned by the platform's log collector (regex over the message
// text — apps that log errors without an "error"-like keyword come as info).
const LOG_LEVELS = ["error", "warn", "info", "debug"];
/** Client-side level filter for SSE streams — the live endpoints have no
 *  server-side `level` param (only the historical query does). Entries
 *  without a level field default to "info", matching the server's parser. */
function matchesLevel(data, level) {
    if (!level)
        return true;
    try {
        const e = JSON.parse(data);
        return ((e && e.level) ?? "info") === level;
    }
    catch {
        return level === "info";
    }
}
export function registerLogs(program) {
    program
        .command("logs")
        .description("Stream runtime logs")
        .option("--build", "Show build logs instead of runtime")
        .option("-s, --service <id>", "Only show logs for a specific service")
        .option("-p, --project <id>", "Project name, slug, or ID")
        .option("--tail <n>", "Print last N log lines and exit (no follow)")
        .option("-l, --level <level>", `Only show logs at this level (${LOG_LEVELS.join("|")})`)
        .option("--restarts [n]", "List last N restart events (default 20) and exit")
        .option("--restart <id>", "Print log tail of a specific restart event (or 'latest')")
        .action(async (opts) => {
        if (opts.restarts !== undefined && opts.restart !== undefined) {
            error("Use --restarts (list) or --restart <id> (detail), not both");
            process.exit(1);
        }
        if (opts.tail !== undefined && (opts.restarts !== undefined || opts.restart !== undefined)) {
            error("--tail cannot be combined with --restarts/--restart");
            process.exit(1);
        }
        if (opts.level && !LOG_LEVELS.includes(opts.level)) {
            error(`Invalid --level "${opts.level}". Choose one of: ${LOG_LEVELS.join(", ")}`);
            process.exit(1);
        }
        if (opts.level && (opts.build || opts.restarts !== undefined || opts.restart !== undefined)) {
            error("--level applies to runtime logs only (not --build/--restarts/--restart)");
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
        let serviceName;
        let serviceKind;
        if (opts.service) {
            const svc = await resolveService(projectId, opts.service);
            serviceId = svc.id;
            serviceName = svc.name;
            serviceKind = svc.kind;
        }
        // --tail: fetch historical logs and exit
        if (tailN !== undefined) {
            if (opts.service && !serviceName) {
                // An empty name would be dropped from the query string and the
                // filter would silently match every service.
                error(`Service "${opts.service}" has no name to filter logs by`);
                process.exit(1);
            }
            // The project log stream tags entries with the service *name*
            // (not ID), so the historical filter must use the name too.
            const entries = await api.get(withScope(withQuery(`/api/projects/${projectId}/logs`, {
                limit: tailN,
                service: serviceName,
                level: opts.level,
            }), scope));
            for (const e of entries)
                printLogEntry(e);
            return;
        }
        if (!serviceId && isTTY() && !isJSONMode()) {
            // Offer to pick a specific service or stream all
            const data = await api.get(withScope(`/api/projects/${projectId}/services`, scope));
            const apps = data.apps || [];
            const addons = data.addons || [];
            if (apps.length + addons.length > 1) {
                const choices = [
                    { value: "all", label: "All services", hint: "stream combined logs" },
                    ...apps.map((a) => ({
                        value: a.id,
                        label: a.name || a.id,
                        hint: a.status,
                    })),
                    ...addons.map((a) => ({
                        value: a.id,
                        label: a.name || a.addonType || a.id,
                        hint: a.status,
                    })),
                ];
                const selected = await p.select({ message: "Show logs for", options: choices });
                if (p.isCancel(selected))
                    process.exit(5);
                if (selected !== "all") {
                    serviceId = selected;
                    serviceKind = addons.some((a) => a.id === selected) ? "addon" : "app";
                }
            }
        }
        const onReconnect = (attempt) => warn(`log stream lost — reconnecting (attempt ${attempt}/5)`);
        const streamHandler = (event, data) => {
            if (event === "error") {
                error(data);
                process.exitCode = 1;
                return false;
            }
            if (!matchesLevel(data, opts.level))
                return true;
            printLogLine(data);
            return true;
        };
        if (serviceId) {
            // Stream logs for a specific service. Addons live on a different
            // endpoint — the app one 404s for them.
            const streamPath = serviceKind === "addon"
                ? withScope(`/api/projects/${projectId}/addons/${serviceId}/logs`, scope)
                : `/api/apps/${serviceId}/logs`;
            const filterNote = opts.level ? ` [level=${opts.level}]` : "";
            info(chalk.dim(`Streaming logs...${filterNote} (Ctrl+C to stop)\n`));
            await streamSSE(streamPath, streamHandler, { reconnect: true, onReconnect });
            return;
        }
        // Stream all project logs
        info(chalk.dim(`Streaming project logs...${opts.level ? ` [level=${opts.level}]` : ""} (Ctrl+C to stop)\n`));
        await streamSSE(withScope(`/api/projects/${projectId}/logs/stream`, scope), streamHandler, { reconnect: true, onReconnect });
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
    // The plain listing is DB-only; crash events still held by vm-agent are
    // merged in by the server only when a buildId is given. Refetch the newest
    // build so `--restart latest` sees crashes that haven't been persisted yet.
    if (builds.length > 0) {
        try {
            const [withLive] = await api.get(withQuery(`/api/apps/${appId}/deploy-events`, { buildId: builds[0].buildId }));
            if (withLive && withLive.buildId === builds[0].buildId)
                builds[0] = withLive;
        }
        catch {
            // node unreachable — the DB-only list is still useful
        }
    }
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
/** Resolve the target for app-only subcommands; addons have no builds or
 *  restart events, so fail with a clear message instead of a server 404. */
async function getActiveApp(serviceRef, projectId, what) {
    const svc = await getActiveServiceWithKind(serviceRef, projectId);
    if (svc.kind === "addon") {
        error(`${what} are only available for apps — "${svc.name}" is an addon`);
        process.exit(1);
    }
    return { id: svc.id, name: svc.name };
}
async function showRestartList(serviceRef, projectId, n) {
    const svc = await getActiveApp(serviceRef, projectId, "Restart events");
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
    const svc = await getActiveApp(serviceRef, projectId, "Restart events");
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
    if (serviceRef || getProjectLink()?.serviceId) {
        // Explicit -s flag, or the service linked to this cwd.
        const svc = await getActiveApp(serviceRef, projectId, "Build logs");
        appId = svc.id;
    }
    else {
        const data = await api.get(withScope(`/api/projects/${projectId}/services`, scope));
        if (!data.apps?.length) {
            throw new Error("No apps in project. Create one with `lizard up` or `lizard add`.");
        }
        appId = data.apps[0].id;
        if (data.apps.length > 1) {
            info(chalk.dim(`Multiple apps — showing ${data.apps[0].name}. Use -s to pick another.`));
        }
    }
    // Get latest build
    const app = await api.get(`/api/apps/${appId}`);
    if (!app.builds?.length) {
        throw new Error("No builds for this app yet. Trigger one with `lizard up` or `lizard redeploy`.");
    }
    const buildId = app.builds[0].id;
    info(chalk.dim(`Build ${buildId}\n`));
    if (tailN !== undefined) {
        // Snapshot semantics: the server replays history immediately; if the
        // build is still running the stream would otherwise follow it forever.
        // Stop after 3s without new events and print what we have.
        //
        // Each SSE event carries a multi-line *chunk* (a logSnippet delta), not a
        // single line — for a finished build the whole log arrives as one event.
        // Reassemble the text first, then tail by line.
        const chunks = [];
        await streamSSE(`/api/builds/${buildId}/logs`, (event, data) => {
            if (event === "done" || event === "error")
                return false;
            try {
                const parsed = JSON.parse(data);
                chunks.push(typeof parsed === "string" ? parsed : data);
            }
            catch {
                chunks.push(data);
            }
            return true;
        }, { idleTimeoutMs: 3000 });
        const lines = chunks.join("").split("\n");
        while (lines.length && lines[lines.length - 1] === "")
            lines.pop();
        for (const line of lines.slice(-tailN)) {
            if (isJSONMode()) {
                process.stdout.write(JSON.stringify({ message: line }) + "\n");
            }
            else {
                process.stdout.write(line + "\n");
            }
        }
        return;
    }
    await streamSSE(`/api/builds/${buildId}/logs`, (event, data) => {
        if (event === "error") {
            // The human-readable "--- Build failed ---" line already arrived as a
            // data event; just make the failure visible to scripts.
            process.exitCode = 1;
            return false;
        }
        if (event === "done")
            return false;
        printLogLine(data);
        return true;
    });
}
//# sourceMappingURL=logs.js.map