#!/usr/bin/env node
import { Command } from "commander";
import chalk from "chalk";
import { setJSONMode, isJSONMode, error } from "./lib/format.js";
import { setTokenOverride, requireAuth } from "./lib/auth.js";
import { setBaseURL, setAccessToken } from "./lib/api.js";
import { checkForUpdateInBackground, CURRENT_VERSION } from "./lib/updater.js";
const BANNER_LINES = [
    "╔═══════════════════════════════════════════════════╗",
    "║                                                   ║",
    "║    ██╗     ██╗███████╗ █████╗ ██████╗ ██████╗     ║",
    "║    ██║     ██║╚══███╔╝██╔══██╗██╔══██╗██╔══██╗    ║",
    "║    ██║     ██║  ███╔╝ ███████║██████╔╝██║  ██║    ║",
    "║    ██║     ██║ ███╔╝  ██╔══██║██╔══██╗██║  ██║    ║",
    "║    ███████╗██║███████╗██║  ██║██║  ██║██████╔╝    ║",
    "║    ╚══════╝╚═╝╚══════╝╚═╝  ╚═╝╚═╝  ╚═╝╚═════╝     ║",
    "║                                                   ║",
    "╚═══════════════════════════════════════════════════╝",
];
const GRADIENT_STOPS = [
    [16, 185, 129], // #10B981
    [212, 165, 116], // #D4A574
];
function gradientLine(line, width) {
    let out = "";
    for (let i = 0; i < line.length; i++) {
        const t = width > 1 ? i / (width - 1) : 0;
        const scaled = t * (GRADIENT_STOPS.length - 1);
        const idx = Math.min(Math.floor(scaled), GRADIENT_STOPS.length - 2);
        const k = scaled - idx;
        const a = GRADIENT_STOPS[idx];
        const b = GRADIENT_STOPS[idx + 1];
        const r = Math.round(a[0] + (b[0] - a[0]) * k);
        const g = Math.round(a[1] + (b[1] - a[1]) * k);
        const bl = Math.round(a[2] + (b[2] - a[2]) * k);
        out += chalk.rgb(r, g, bl)(line[i]);
    }
    return out;
}
const BANNER_WIDTH = Math.max(...BANNER_LINES.map((l) => l.length));
const BANNER = BANNER_LINES.map((l) => gradientLine(l, BANNER_WIDTH)).join("\n");
// Commands (alphabetical by command name)
import { registerAdd } from "./commands/add.js";
import { registerDocs } from "./commands/docs.js";
import { registerDomain } from "./commands/domain.js";
import { registerDown } from "./commands/down.js";
import { registerGit } from "./commands/git.js";
import { registerInit } from "./commands/init.js";
import { registerLink } from "./commands/link.js";
import { registerList } from "./commands/list.js";
import { registerLogin } from "./commands/login.js";
import { registerLogout } from "./commands/logout.js";
import { registerLogs } from "./commands/logs.js";
import { registerOpen } from "./commands/open.js";
import { registerPort } from "./commands/port.js";
import { registerProjects } from "./commands/projects.js";
import { registerPs } from "./commands/ps.js";
import { registerRedeploy } from "./commands/redeploy.js";
import { registerRegions } from "./commands/regions.js";
import { registerRestart } from "./commands/restart.js";
import { registerRun } from "./commands/run.js";
import { registerScale } from "./commands/scale.js";
import { registerSecrets } from "./commands/secrets.js";
import { registerService } from "./commands/service.js";
import { registerSSH } from "./commands/ssh.js";
import { registerUnlink } from "./commands/unlink.js";
import { registerUp } from "./commands/up.js";
import { registerUpdate } from "./commands/update.js";
import { registerWhoami } from "./commands/whoami.js";
const program = new Command();
program
    .name("lizard")
    .description("Lizard CLI — deploy and manage apps on Lizard")
    .version(CURRENT_VERSION)
    .addHelpText("before", BANNER + "\n")
    .configureHelp({
    subcommandTerm: (cmd) => {
        const alias = cmd.aliases()[0];
        return alias ? `${cmd.name()}|${alias}` : cmd.name();
    },
})
    .option("--json", "Output in JSON format")
    .option("-w, --workspace <id>", "Workspace name or ID")
    .option("--region <region>", "Region for creating services")
    .option("--token <token>", "API token")
    .hook("preAction", async (thisCommand, actionCommand) => {
    const opts = thisCommand.opts();
    // Check for updates silently in background (shows notice after command)
    if (actionCommand.name() !== "update") {
        checkForUpdateInBackground();
    }
    // JSON mode: explicit flag or non-TTY stdout
    if (opts.json || !process.stdout.isTTY) {
        setJSONMode(true);
    }
    // Token override
    if (opts.token) {
        setTokenOverride(opts.token);
    }
    // API URL override
    if (process.env.LIZARD_API_URL) {
        setBaseURL(process.env.LIZARD_API_URL);
    }
    // Commands that don't need auth
    const noAuth = new Set(["login", "logout", "update", "help", "docs"]);
    if (noAuth.has(actionCommand.name()))
        return;
    // Require auth — auto-triggers login flow if not logged in
    const creds = await requireAuth();
    setAccessToken(creds.accessToken);
});
// Register all commands (alphabetical)
registerAdd(program);
registerDocs(program);
registerDomain(program);
registerDown(program);
registerGit(program);
registerInit(program);
registerLink(program);
registerList(program);
registerLogin(program);
registerLogout(program);
registerLogs(program);
registerOpen(program);
registerPort(program);
registerProjects(program);
registerPs(program);
registerRedeploy(program);
registerRegions(program);
registerRestart(program);
registerRun(program);
registerScale(program);
registerSecrets(program);
registerService(program);
registerSSH(program);
registerUnlink(program);
registerUp(program);
registerUpdate(program);
registerWhoami(program);
// Error handling
program.exitOverride();
async function main() {
    try {
        await program.parseAsync(process.argv);
    }
    catch (err) {
        // Commander throws for --help, --version, etc. — ignore those
        if (err.code === "commander.helpDisplayed" || err.code === "commander.version") {
            process.exit(0);
        }
        if (err.code === "commander.help") {
            process.exit(0);
        }
        const msg = err.message || String(err);
        if (isJSONMode()) {
            console.log(JSON.stringify({
                error: {
                    code: err.code || "ERROR",
                    message: msg,
                },
            }, null, 2));
        }
        else {
            error(msg);
        }
        // Exit codes per spec
        if (msg.includes("Not authenticated") || msg.includes("Invalid token")) {
            process.exit(2);
        }
        if (msg.includes("not found") || msg.includes("Not found")) {
            process.exit(3);
        }
        if (msg.includes("timeout") || msg.includes("Timeout")) {
            process.exit(4);
        }
        process.exit(1);
    }
}
main();
//# sourceMappingURL=index.js.map