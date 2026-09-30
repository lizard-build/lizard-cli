import chalk from "chalk";
import WebSocket from "ws";
import { getBaseURL, getRequestToken } from "../lib/api.js";
/**
 * `lizard sandbox ssh <id>` — an interactive shell in a running sandbox.
 *
 * Not the SSH protocol: it opens the same terminal the dashboard uses
 * (wss://…/api/sandboxes/terminal), which the platform bridges onto an exec into the
 * sandbox's pod with a TTY. So there are no keys to set up and nothing to open — the
 * CLI's own API key is the credential, and a workspace- or project-scoped key only
 * reaches sandboxes in its scope.
 *
 * Wire protocol (server/src/routes/ws.ts): binary frames are raw terminal bytes both
 * ways; a text frame {"type":"resize","cols":N,"rows":M} resizes the remote TTY.
 */
export async function sandboxShell(id) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
        throw new Error("`lizard sandbox ssh` needs an interactive terminal. To run a command, use `lizard sandbox exec <id> -- <cmd>`.");
    }
    const token = getRequestToken();
    if (!token)
        throw new Error("Not logged in. Run `lizard login` first.");
    const base = new URL(getBaseURL());
    base.protocol = base.protocol === "http:" ? "ws:" : "wss:";
    const url = new URL(`/api/sandboxes/terminal?id=${encodeURIComponent(id)}`, base);
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
    const stdin = process.stdin;
    const stdout = process.stdout;
    let rawMode = false;
    const restore = () => {
        if (rawMode) {
            try {
                stdin.setRawMode(false);
            }
            catch { /* stdin closed */ }
            rawMode = false;
        }
        stdin.pause();
        stdin.removeAllListeners("data");
        stdout.removeAllListeners("resize");
    };
    const sendSize = () => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "resize", cols: stdout.columns || 80, rows: stdout.rows || 24 }));
        }
    };
    return await new Promise((settle) => {
        let opened = false;
        // ws emits `error` and then `close` for one failure: report and settle once.
        let finished = false;
        const resolve = (code) => { if (!finished) {
            finished = true;
            settle(code);
        } };
        ws.on("open", () => {
            stdin.setRawMode(true);
            rawMode = true;
            stdin.resume();
            // Raw mode: Ctrl-C, Ctrl-Z, arrows and tab completion all go to the remote shell.
            stdin.on("data", (chunk) => { if (ws.readyState === WebSocket.OPEN)
                ws.send(chunk, { binary: true }); });
            stdout.on("resize", sendSize);
            sendSize();
        });
        ws.on("message", (data) => {
            // The socket opens before the server has checked the sandbox, so "connected" is
            // only true once the shell itself speaks.
            if (!opened) {
                opened = true;
                stdout.write(chalk.dim(`Connected to ${id}. Type \`exit\` or press Ctrl-D to leave.\r\n`));
            }
            stdout.write(Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data));
        });
        ws.on("close", (code, reasonBuf) => {
            if (finished)
                return;
            restore();
            const reason = reasonBuf.toString();
            // 1000 with "Shell exited" is the normal end of a session.
            if (code === 1000 || code === 1005) {
                if (opened)
                    stdout.write(chalk.dim(`\r\nConnection to ${id} closed.\r\n`));
                resolve(0);
                return;
            }
            const why = {
                4001: "Not authorized — your login or API key was rejected. Run `lizard login`.",
                4003: reason || "Forbidden — this sandbox is not in a workspace your key can reach.",
                4004: `Sandbox ${id} not found.`,
            };
            stdout.write(chalk.red(`\r\n${why[code] ?? (reason || `Connection closed (${code}).`)}\r\n`));
            resolve(1);
        });
        ws.on("error", (err) => {
            if (finished)
                return;
            restore();
            stdout.write(chalk.red(`\r\nCould not connect to ${id}: ${err.message}\r\n`));
            resolve(1);
        });
    });
}
//# sourceMappingURL=sandbox-ssh.js.map