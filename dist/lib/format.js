import chalk from "chalk";
export function isTTY() {
    return Boolean(process.stdout.isTTY);
}
let jsonMode = false;
export function setJSONMode(on) {
    jsonMode = on;
}
export function isJSONMode() {
    return jsonMode;
}
export function printJSON(data) {
    console.log(JSON.stringify(data, null, 2));
}
export function success(msg) {
    if (jsonMode)
        return;
    process.stderr.write(chalk.green("✓") + " " + msg + "\n");
}
export function error(msg) {
    process.stderr.write(chalk.red("Error:") + " " + msg + "\n");
}
export function warn(msg) {
    process.stderr.write(chalk.yellow("Warning:") + " " + msg + "\n");
}
export function info(msg) {
    if (jsonMode)
        return;
    process.stderr.write(msg + "\n");
}
export function table(headers, rows) {
    if (rows.length === 0)
        return;
    const widths = headers.map((h) => h.length);
    for (const row of rows) {
        for (let i = 0; i < row.length; i++) {
            if (i < widths.length) {
                widths[i] = Math.max(widths[i], (row[i] || "").length);
            }
        }
    }
    const header = headers
        .map((h, i) => h.toUpperCase().padEnd(widths[i]))
        .join("  ");
    console.log(chalk.dim(header));
    for (const row of rows) {
        const line = headers
            .map((_, i) => (row[i] || "").padEnd(widths[i]))
            .join("  ");
        console.log(line);
    }
}
export function statusColor(status) {
    switch (status) {
        case "running":
            return chalk.green(status);
        case "failed":
        case "error":
            return chalk.red(status);
        case "building":
        case "deploying":
        case "restarting":
        case "pending":
            return chalk.yellow(status);
        case "deleting":
            return chalk.dim(status);
        default:
            return status;
    }
}
export function timeAgo(ts) {
    const ms = typeof ts === "string" ? Date.parse(ts) : ts;
    const diff = Date.now() - ms;
    const secs = Math.floor(diff / 1000);
    if (secs < 60)
        return `${secs}s ago`;
    const mins = Math.floor(secs / 60);
    if (mins < 60)
        return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24)
        return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
}
//# sourceMappingURL=format.js.map