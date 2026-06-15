import chalk from "chalk";
import { api, withScope, withQuery, APIError } from "../lib/api.js";
import { getProjectLink } from "../lib/config.js";
import { resolveProjectScope, getActiveServiceWithKind } from "../lib/resolve.js";
import { info, fail, isJSONMode, printJSON, table, timeAgo } from "../lib/format.js";
const RANGES = ["1h", "6h", "24h", "7d", "14d", "30d"];
export function registerMetrics(program) {
    program
        .command("metrics")
        .description("Show resource metrics (CPU, memory, network, disk) and cost")
        .option("-s, --service <id>", "Service name or ID (defaults to linked service)")
        .option("-p, --project <id>", "Project name, slug, or ID")
        .option("-r, --range <range>", `Time range: ${RANGES.join("|")}`, "1h")
        .option("-w, --watch", "Live view, refreshed every 3s (Ctrl+C to stop)")
        .option("--cost", "Show running resources, cost per hour, and current billing-period usage (incl. egress)")
        .action(async (opts) => {
        if (!RANGES.includes(opts.range)) {
            fail(`Invalid --range "${opts.range}". Choose one of: ${RANGES.join(", ")}`);
        }
        if (opts.watch && isJSONMode()) {
            fail("--watch is interactive and cannot be combined with --json (poll without --watch instead)");
        }
        const { projectId, scope } = await resolveProjectScope(opts.project);
        if (opts.cost) {
            await showCost(projectId, scope);
            return;
        }
        // Service detail when -s is given or a service is linked; otherwise
        // an overview of every service in the project.
        const hasService = Boolean(opts.service || getProjectLink()?.serviceId);
        if (opts.watch) {
            let serviceId;
            if (hasService) {
                serviceId = (await getActiveServiceWithKind(opts.service, projectId)).id;
            }
            await watchLive(projectId, scope, serviceId);
            return;
        }
        if (hasService) {
            await showServiceMetrics(opts.service, projectId, scope, opts.range);
        }
        else {
            await showProjectOverview(projectId, scope);
        }
    });
}
// ── Formatting helpers ────────────────────────────────────────────────────
function fmtBytes(b) {
    if (!isFinite(b) || b < 0)
        return "—";
    if (b < 1024)
        return `${Math.round(b)} B`;
    if (b < 1024 * 1024)
        return `${(b / 1024).toFixed(1)} KB`;
    if (b < 1024 * 1024 * 1024)
        return `${(b / 1024 / 1024).toFixed(1)} MB`;
    return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
function fmtRate(b) {
    return `${fmtBytes(b)}/s`;
}
function fmtMb(mb) {
    return fmtBytes(mb * 1024 * 1024);
}
function fmtVcpu(v) {
    return v.toFixed(2);
}
/** Render values as a unicode sparkline, downsampled to `width` buckets. */
function sparkline(values, width = 30) {
    if (values.length === 0)
        return "";
    const blocks = "▁▂▃▄▅▆▇█";
    const buckets = [];
    const per = Math.max(1, Math.ceil(values.length / width));
    for (let i = 0; i < values.length; i += per) {
        const slice = values.slice(i, i + per);
        buckets.push(slice.reduce((a, b) => a + b, 0) / slice.length);
    }
    const max = Math.max(...buckets);
    if (max <= 0)
        return chalk.dim(blocks[0].repeat(buckets.length));
    return buckets
        .map((v) => blocks[Math.min(blocks.length - 1, Math.floor((v / max) * (blocks.length - 1) + 0.5))])
        .join("");
}
function seriesByName(series, name) {
    return series.find((s) => s.metric === name)?.values ?? [];
}
/** min/avg/max over a series. Rate metrics carry an artificial 0 as their
 *  first sample (no previous counter to diff against) — skip it. */
function stats(values, isRate = false) {
    const vals = isRate && values.length > 1 ? values.slice(1) : values;
    if (vals.length === 0)
        return null;
    return {
        now: vals[vals.length - 1],
        min: Math.min(...vals),
        avg: vals.reduce((a, b) => a + b, 0) / vals.length,
        max: Math.max(...vals),
        values: vals,
    };
}
// ── Service detail ────────────────────────────────────────────────────────
async function fetchServiceMetrics(svc, projectId, scope, range) {
    const path = svc.kind === "app"
        ? withQuery(`/api/apps/${svc.id}/metrics`, { range })
        : withScope(withQuery(`/api/projects/${projectId}/addons/${svc.id}/metrics`, { range }), scope);
    return api.get(path);
}
async function showServiceMetrics(serviceFlag, projectId, scope, range) {
    const svc = await getActiveServiceWithKind(serviceFlag, projectId);
    const data = await fetchServiceMetrics(svc, projectId, scope, range);
    if (isJSONMode()) {
        printJSON({ service: { id: svc.id, name: svc.name, kind: svc.kind }, range, ...data });
        return;
    }
    const { series, latest, limits } = data;
    if (series.length === 0 && !latest) {
        info(chalk.dim(`No metrics for ${svc.name} yet — the service may be new or stopped.`));
        return;
    }
    const sampled = latest ? timeAgo(latest.sampledAt) : chalk.dim("no live data");
    console.log(chalk.bold(svc.name) + chalk.dim(` (${svc.kind}) — last ${range}, sampled ${sampled}`));
    console.log();
    const cpu = stats(seriesByName(series, "cpu"));
    const mem = stats(seriesByName(series, "memory"));
    const rx = stats(seriesByName(series, "network_rx"), true);
    const tx = stats(seriesByName(series, "network_tx"), true);
    const dr = stats(seriesByName(series, "disk_read"), true);
    const dw = stats(seriesByName(series, "disk_write"), true);
    const rows = [];
    const push = (label, s, fmt, now) => {
        if (!s)
            return;
        const current = now ?? s.now;
        rows.push([
            label,
            current === null || current === undefined ? chalk.dim("—") : fmt(current),
            fmt(s.min),
            fmt(s.avg),
            fmt(s.max),
            chalk.cyan(sparkline(s.values)),
        ]);
    };
    // "Now" for CPU/memory prefers the live Redis snapshot over the last
    // (up to 90s stale) historical sample.
    push("CPU (vCPU)", cpu, fmtVcpu, latest ? latest.cpu : undefined);
    push("Memory", mem, fmtBytes, latest ? latest.memUsedMb * 1024 * 1024 : undefined);
    push("Net ↓", rx, fmtRate);
    push("Net ↑", tx, fmtRate);
    push("Disk read", dr, fmtRate);
    push("Disk write", dw, fmtRate);
    if (rows.length > 0) {
        table(["Metric", "Now", "Min", "Avg", "Max", "Trend"], rows);
    }
    else if (latest) {
        // Live snapshot only (brand-new VM, no history rows yet)
        table(["Metric", "Now"], [
            ["CPU (vCPU)", fmtVcpu(latest.cpu)],
            ["Memory", `${fmtMb(latest.memUsedMb)} / ${fmtMb(latest.memTotalMb)}`],
        ]);
    }
    console.log();
    const diskUsed = seriesByName(series, "disk_used");
    const diskTotal = seriesByName(series, "disk_total");
    if (diskUsed.length > 0) {
        const used = diskUsed[diskUsed.length - 1];
        const total = diskTotal[diskTotal.length - 1] ?? 0;
        console.log(chalk.dim("Disk used  ") + fmtBytes(used) + (total > 0 ? chalk.dim(` / ${fmtBytes(total)}`) : ""));
    }
    console.log(chalk.dim("Limits     ") +
        `${(limits.cpuMillis / 1000).toFixed(limits.cpuMillis % 1000 === 0 ? 0 : 1)} vCPU · ${fmtMb(limits.memoryMi)} memory`);
}
// ── Project overview ──────────────────────────────────────────────────────
async function fetchLive(projectId, scope) {
    const data = await api.get(withScope(withQuery(`/api/projects/${projectId}/metrics`, { live: true }), scope));
    return (data.services || []).filter((s) => !s.deleted);
}
function overviewRows(services) {
    return services.map((s) => {
        const cpuLimit = s.limits.cpuMillis / 1000;
        return [
            s.label,
            s.type,
            s.latest ? `${fmtVcpu(s.latest.cpu)} / ${cpuLimit}` : chalk.dim("—"),
            s.latest ? `${fmtMb(s.latest.memUsedMb)} / ${fmtMb(s.latest.memTotalMb)}` : chalk.dim("—"),
            s.latest ? timeAgo(s.latest.sampledAt) : chalk.dim("no data"),
        ];
    });
}
async function showProjectOverview(projectId, scope) {
    const services = await fetchLive(projectId, scope);
    if (isJSONMode()) {
        printJSON({ services });
        return;
    }
    if (services.length === 0) {
        console.log("No services. Use `lizard add` or `lizard up`.");
        return;
    }
    table(["Service", "Type", "CPU (vCPU)", "Memory", "Sampled"], overviewRows(services));
    info(chalk.dim("\nDetails: lizard metrics -s <service>   Live: lizard metrics --watch"));
}
// ── Watch mode ────────────────────────────────────────────────────────────
async function watchLive(projectId, scope, serviceId) {
    info(chalk.dim("Watching metrics... (Ctrl+C to stop)"));
    // Capture console output so each refresh replaces the previous frame
    // instead of scrolling.
    for (;;) {
        let services;
        try {
            services = await fetchLive(projectId, scope);
        }
        catch (e) {
            fail(e.message || String(e));
        }
        if (serviceId)
            services = services.filter((s) => s.id === serviceId);
        process.stdout.write("\x1b[2J\x1b[H"); // clear screen, cursor home
        console.log(chalk.dim(new Date().toLocaleTimeString()) + chalk.dim("  (refreshes every 3s, Ctrl+C to stop)"));
        console.log();
        if (services.length === 0) {
            console.log(chalk.dim("No services."));
        }
        else {
            table(["Service", "Type", "CPU (vCPU)", "Memory", "Sampled"], overviewRows(services));
        }
        await new Promise((r) => setTimeout(r, 3000));
    }
}
const HOUR_MS = 3_600_000;
// Object storage is priced per GB/month on a 30-day basis (matches the backend).
const OBJECT_MONTH_SECONDS = 2_592_000;
// Current-period usage and cost, mirroring the web Usage page
// (ProjectUsageView's resource breakdown): quantities × prices straight from
// /api/billing/summary; CPU/memory/volumes estimates ride the project's
// current measured rates, while egress and object storage — cumulative
// throughput with no steady-state hourly rate — extrapolate linearly from
// usage so far. The extrapolation anchor is the later of the billing-period
// start and the oldest service's createdAt, so a mid-period project's burst
// isn't smeared across time it didn't exist. A frozen workspace accrues
// nothing — estimates collapse to the actuals.
async function fetchPeriodUsage(projectId, workspaceId) {
    const [summaryR, servicesR, accountR] = await Promise.allSettled([
        api.get(withQuery("/api/billing/summary", { workspaceId })),
        api.get(withScope(`/api/projects/${projectId}/services`, { workspaceId })),
        api.get(withQuery("/api/billing/account", { workspaceId })),
    ]);
    if (summaryR.status !== "fulfilled")
        return null;
    const summary = summaryR.value;
    const mine = summary.projects?.find((p) => p.projectId === projectId);
    const prices = summary.prices;
    if (!mine || !prices)
        return null;
    const isFrozen = accountR.status === "fulfilled" && accountR.value.status === "frozen";
    const now = Date.now();
    const remainingHours = isFrozen ? 0 : Math.max(0, (summary.periodEnd - now) / HOUR_MS);
    const services = servicesR.status === "fulfilled" ? servicesR.value : {};
    const createdAts = [...(services.apps ?? []), ...(services.addons ?? [])]
        .map((s) => s.createdAt)
        .filter((t) => typeof t === "number" && t > 0);
    const projectStart = createdAts.length > 0 ? Math.min(...createdAts) : summary.periodStart;
    const throughputStart = Math.max(summary.periodStart, projectStart);
    const elapsedHrs = Math.max(0.001, (now - throughputStart) / HOUR_MS);
    const monthHrs = Math.max(elapsedHrs, (summary.periodEnd - summary.periodStart) / HOUR_MS);
    const linearFactor = isFrozen ? 1 : monthHrs / elapsedHrs;
    const avgs = summary.currentAvgsByProject?.[projectId];
    const cpuCost = (mine.cpuVcpuSeconds ?? 0) * prices.cpuPerVcpuPerSec;
    const memCost = (mine.memoryGbSeconds ?? 0) * prices.memoryPerGbPerSec;
    const volCost = (mine.storageGbSeconds ?? 0) * prices.storagePerGbPerSec;
    const egressGb = (mine.egressBytes ?? 0) / 1e9;
    const egressCost = egressGb * prices.egressPerGb;
    const objCost = ((mine.objectStorageGbSeconds ?? 0) / OBJECT_MONTH_SECONDS) * (prices.objectStoragePerGbMonth ?? 0);
    const allRows = [
        {
            key: "cpu",
            label: "CPU",
            usage: (mine.cpuVcpuSeconds ?? 0) / 3600,
            usageUnit: "vCPU·hr",
            costUsd: cpuCost,
            estimatedUsd: cpuCost + (avgs?.vcpu ?? 0) * prices.cpuPerVcpuPerSec * 3600 * remainingHours,
        },
        {
            key: "memory",
            label: "Memory",
            usage: (mine.memoryGbSeconds ?? 0) / 3600,
            usageUnit: "GB·hr",
            costUsd: memCost,
            estimatedUsd: memCost + (avgs?.memGb ?? 0) * prices.memoryPerGbPerSec * 3600 * remainingHours,
        },
        {
            key: "volumes",
            label: "Volumes",
            usage: (mine.storageGbSeconds ?? 0) / 3600,
            usageUnit: "GB·hr",
            costUsd: volCost,
            estimatedUsd: volCost + (avgs?.storageGb ?? 0) * prices.storagePerGbPerSec * 3600 * remainingHours,
        },
        {
            key: "egress",
            label: "Egress",
            usage: egressGb,
            usageUnit: "GB",
            costUsd: egressCost,
            estimatedUsd: egressCost > 0 ? egressCost * linearFactor : 0,
        },
        {
            key: "object",
            label: "Object Storage",
            usage: (mine.objectStorageGbSeconds ?? 0) / 3600,
            usageUnit: "GB·hr",
            costUsd: objCost,
            estimatedUsd: objCost > 0 ? objCost * linearFactor : 0,
        },
    ];
    const rows = allRows.filter((r) => r.key === "object" || r.costUsd > 0 || r.usage > 0);
    return {
        periodStart: summary.periodStart,
        periodEnd: summary.periodEnd,
        rows,
        totalCostUsd: rows.reduce((s, r) => s + r.costUsd, 0),
        totalEstimatedUsd: rows.reduce((s, r) => s + r.estimatedUsd, 0),
    };
}
function fmtPeriodDate(ms) {
    return new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
async function showCost(projectId, scope) {
    if (!scope.workspaceId) {
        fail("Could not resolve the workspace for this project. Run `lizard link` first.");
    }
    let data;
    let usage;
    try {
        [data, usage] = await Promise.all([
            api.get(withQuery("/api/billing/live", { workspaceId: scope.workspaceId })),
            fetchPeriodUsage(projectId, scope.workspaceId),
        ]);
    }
    catch (e) {
        if (e instanceof APIError && e.status === 403) {
            fail("Billing is only visible to the workspace owner.", 2);
        }
        throw e;
    }
    const mine = data.resources.filter((r) => r.projectId === projectId);
    const projectCost = mine.reduce((a, r) => a + r.costPerHour, 0);
    if (isJSONMode()) {
        printJSON({
            projectId,
            resources: mine,
            projectCostPerHour: projectCost,
            workspaceCostPerHour: data.costPerHour,
            currentPeriod: usage,
        });
        return;
    }
    if (mine.length === 0) {
        console.log("No running resources in this project.");
    }
    else {
        table(["Resource", "Type", "vCPU", "Memory", "Storage", "$/hr"], mine.map((r) => [
            r.name,
            r.addonType ? `addon (${r.addonType})` : r.type,
            fmtVcpu(r.vcpu),
            `${r.memoryGb.toFixed(2)} GB`,
            r.storageGb > 0 ? `${r.storageGb} GB` : chalk.dim("—"),
            `$${r.costPerHour.toFixed(4)}`,
        ]));
        console.log();
        console.log(chalk.dim("Project   ") +
            `$${projectCost.toFixed(4)}/hr` +
            chalk.dim(` (~$${(projectCost * 730).toFixed(2)}/mo at current usage)`));
    }
    console.log(chalk.dim("Workspace ") + `$${data.costPerHour.toFixed(4)}/hr`);
    if (usage && usage.rows.length > 0) {
        console.log();
        console.log(chalk.bold("This billing period") +
            chalk.dim(` (${fmtPeriodDate(usage.periodStart)} – ${fmtPeriodDate(usage.periodEnd)})`));
        table(["Resource", "Usage", "Cost so far", "Est. period total"], [
            ...usage.rows.map((r) => [
                r.label,
                `${r.usage.toFixed(2)} ${r.usageUnit}`,
                `$${r.costUsd.toFixed(4)}`,
                `$${r.estimatedUsd.toFixed(2)}`,
            ]),
            [
                chalk.bold("Total"),
                "",
                chalk.bold(`$${usage.totalCostUsd.toFixed(4)}`),
                chalk.bold(`$${usage.totalEstimatedUsd.toFixed(2)}`),
            ],
        ]);
    }
}
//# sourceMappingURL=metrics.js.map