#!/usr/bin/env node
import { Command } from "commander";
import chalk from "chalk";
import { setJSONMode, isJSONMode, error } from "./lib/format.js";
import { requireAuth } from "./lib/auth.js";
import { setBaseURL, setAccessToken, APIError } from "./lib/api.js";
import { checkForUpdateInBackground, CURRENT_VERSION } from "./lib/updater.js";
const BANNER = chalk.rgb(16, 185, 129)([
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
].join("\n"));
// Commands (alphabetical by command name)
import { registerAdd } from "./commands/add.js";
import { registerConfig } from "./commands/config.js";
import { registerDocs } from "./commands/docs.js";
import { registerDomain } from "./commands/domain.js";
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
import { registerStatus } from "./commands/status.js";
import { registerUnlink } from "./commands/unlink.js";
import { registerUp } from "./commands/up.js";
import { registerUpgrade } from "./commands/upgrade.js";
import { registerWhoami } from "./commands/whoami.js";
import { registerWorkspace } from "./commands/workspace.js";
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
    .option("--json", "Output in JSON format (combine with --help to dump machine-readable command schema for agents)")
    .hook("preAction", async (thisCommand, actionCommand) => {
    const opts = thisCommand.opts();
    // Check for updates silently in background (shows notice after command)
    if (actionCommand.name() !== "upgrade") {
        checkForUpdateInBackground();
    }
    // JSON mode: explicit flag or non-TTY stdout
    if (opts.json || !process.stdout.isTTY) {
        setJSONMode(true);
    }
    // API URL override
    if (process.env.LIZARD_API_URL) {
        setBaseURL(process.env.LIZARD_API_URL);
    }
    // Top-level commands that don't need auth. `status` prints the local link;
    // the optional workspace backfill silently no-ops when not authed.
    //
    // Match by name AND parent — otherwise leaf subcommands sharing a name
    // (e.g. `git status`, `up status`) skip the auto-login flow and would
    // 401 instead of prompting the user to log in.
    const noAuth = new Set(["login", "logout", "upgrade", "help", "docs", "status"]);
    const isTopLevel = actionCommand.parent === thisCommand;
    if (isTopLevel && noAuth.has(actionCommand.name()))
        return;
    // Require auth — auto-triggers login flow if not logged in
    const creds = await requireAuth();
    setAccessToken(creds.accessToken);
});
// Register all commands (alphabetical)
registerAdd(program);
registerConfig(program);
registerDocs(program);
registerDomain(program);
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
registerStatus(program);
registerUnlink(program);
registerUp(program);
registerUpgrade(program);
registerWhoami(program);
registerWorkspace(program);
// Error handling
program.exitOverride();
const EXIT_CODES = {
    "0": "success",
    "1": "generic error",
    "2": "auth (401/403)",
    "3": "not found (404)",
    "4": "timeout (408/504)",
    "5": "cancelled by user",
};
function isHelpJsonRequest(argv) {
    const hasHelp = argv.some((a) => a === "--help" || a === "-h");
    const hasJson = argv.some((a) => a === "--json");
    return hasHelp && hasJson;
}
function collectValueFlags(cmd, acc) {
    for (const opt of cmd.options) {
        if (opt.required || opt.optional) {
            if (opt.short)
                acc.add(opt.short);
            if (opt.long)
                acc.add(opt.long);
        }
    }
    for (const sub of cmd.commands)
        collectValueFlags(sub, acc);
}
function findTargetCommand(argv, root) {
    const valueFlags = new Set();
    collectValueFlags(root, valueFlags);
    let cur = root;
    for (let i = 2; i < argv.length; i++) {
        const tok = argv[i];
        if (tok === "--help" || tok === "-h" || tok === "--json")
            continue;
        if (tok.startsWith("-")) {
            if (tok.includes("="))
                continue;
            if (valueFlags.has(tok) && i + 1 < argv.length)
                i++;
            continue;
        }
        const sub = cur.commands.find((c) => c.name() === tok || c.aliases().includes(tok));
        if (!sub)
            break;
        cur = sub;
    }
    return cur;
}
function dumpOption(o) {
    return {
        flags: o.flags,
        long: o.long ?? null,
        short: o.short ?? null,
        description: o.description ?? "",
        takesValue: Boolean(o.required || o.optional),
        valueRequired: Boolean(o.required),
        defaultValue: o.defaultValue ?? null,
        choices: o.argChoices ?? null,
        negate: Boolean(o.negate),
    };
}
function dumpCommand(cmd) {
    const args = (cmd.registeredArguments ?? []).map((a) => ({
        name: a.name(),
        description: a.description ?? "",
        required: Boolean(a.required),
        variadic: Boolean(a.variadic),
        defaultValue: a.defaultValue ?? null,
        choices: a.argChoices ?? null,
    }));
    return {
        name: cmd.name(),
        aliases: cmd.aliases(),
        description: cmd.description(),
        usage: cmd.usage(),
        arguments: args,
        options: cmd.options
            .filter((o) => !o.hidden)
            .map(dumpOption),
        subcommands: cmd.commands
            .filter((c) => !c._hidden)
            .map(dumpCommand),
    };
}
async function main() {
    // Set JSON mode from argv *before* parseAsync so the catch block below
    // honors --json even when commander rejects before our preAction hook
    // fires (e.g. unknown command, malformed global flag). Non-TTY auto-mode
    // stays in preAction — `lizard --help | less` shouldn't suddenly emit JSON.
    if (process.argv.includes("--json")) {
        setJSONMode(true);
    }
    if (isHelpJsonRequest(process.argv)) {
        const target = findTargetCommand(process.argv, program);
        const isRoot = target === program;
        const out = {
            cli: "lizard",
            version: CURRENT_VERSION,
            command: dumpCommand(target),
            globalOptions: isRoot
                ? []
                : program.options.filter((o) => !o.hidden).map(dumpOption),
            exitCodes: EXIT_CODES,
        };
        process.stdout.write(JSON.stringify(out, null, 2) + "\n");
        process.exit(0);
    }
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
        const apiErr = err instanceof APIError ? err : undefined;
        const status = apiErr?.status;
        const code = apiErr?.code || err.code || "ERROR";
        if (isJSONMode()) {
            console.log(JSON.stringify({
                error: {
                    code,
                    status: status ?? null,
                    message: msg,
                    body: apiErr?.body ?? null,
                },
            }, null, 2));
        }
        else {
            error(msg);
        }
        // Exit codes derived from APIError.status (or tagged error codes), not message text
        const isAuth = status === 401 || status === 403 || code === "NOT_AUTHENTICATED";
        const isNotFound = status === 404;
        const isTimeout = status === 408 ||
            status === 504 ||
            err.name === "AbortError" ||
            err.code === "ETIMEDOUT" ||
            err.code === "UND_ERR_CONNECT_TIMEOUT";
        if (isAuth)
            process.exit(2);
        if (isNotFound)
            process.exit(3);
        if (isTimeout)
            process.exit(4);
        process.exit(1);
    }
}
main();
//# sourceMappingURL=index.js.map