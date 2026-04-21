#!/usr/bin/env node
import { Command } from "commander";
import { setJSONMode, isJSONMode, error } from "./lib/format.js";
import { setTokenOverride, requireAuth } from "./lib/auth.js";
import { setBaseURL, setAccessToken } from "./lib/api.js";
// Commands
import { registerLogin } from "./commands/login.js";
import { registerLogout } from "./commands/logout.js";
import { registerWhoami } from "./commands/whoami.js";
import { registerInit } from "./commands/init.js";
import { registerLink } from "./commands/link.js";
import { registerProjects } from "./commands/projects.js";
import { registerDeploy } from "./commands/deploy.js";
import { registerPs } from "./commands/ps.js";
import { registerAdd } from "./commands/add.js";
import { registerDestroy } from "./commands/destroy.js";
import { registerRestart } from "./commands/restart.js";
import { registerRedeploy } from "./commands/redeploy.js";
import { registerLogs } from "./commands/logs.js";
import { registerSecrets } from "./commands/secrets.js";
import { registerRegions } from "./commands/regions.js";
import { registerStatus } from "./commands/status.js";
import { registerOpen } from "./commands/open.js";
import { registerRun } from "./commands/run.js";
import { registerConnect } from "./commands/connect.js";
import { registerContext } from "./commands/context.js";
import { registerGit } from "./commands/git.js";
import { registerVersion } from "./commands/version.js";
import { registerUpdate } from "./commands/update.js";
const program = new Command();
program
    .name("lizard")
    .description("Lizard CLI — deploy and manage apps on Lizard")
    .version("0.1.0")
    .option("--json", "Output in JSON format")
    .option("-y, --yes", "Skip confirmation prompts")
    .option("--workspace <id>", "Workspace name or ID")
    .option("--project <id>", "Project ID")
    .option("--environment <name>", "Environment name")
    .option("--region <region>", "Region for creating services")
    .option("--token <token>", "API token")
    .option("--no-color", "Disable colors")
    .option("--verbose", "Verbose output")
    .hook("preAction", async (thisCommand, actionCommand) => {
    const opts = thisCommand.opts();
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
    const noAuth = new Set(["login", "logout", "version", "completion", "update", "help"]);
    if (noAuth.has(actionCommand.name()))
        return;
    // Require auth — auto-triggers login flow if not logged in
    const creds = await requireAuth();
    setAccessToken(creds.accessToken);
});
// Register all commands
registerLogin(program);
registerLogout(program);
registerWhoami(program);
registerInit(program);
registerLink(program);
registerProjects(program);
registerDeploy(program);
registerPs(program);
registerAdd(program);
registerDestroy(program);
registerRestart(program);
registerRedeploy(program);
registerLogs(program);
registerSecrets(program);
registerRegions(program);
registerStatus(program);
registerOpen(program);
registerRun(program);
registerConnect(program);
registerContext(program);
registerGit(program);
registerVersion(program);
registerUpdate(program);
// Shell completion
program
    .command("completion")
    .argument("<shell>", "Shell type (bash, zsh, fish)")
    .description("Generate shell completion script")
    .action((shell) => {
    // Commander doesn't have built-in completion like Cobra
    // Point users to manual setup
    console.log(`# Add to your .${shell}rc:`);
    if (shell === "bash") {
        console.log(`eval "$(lizard completion bash)"`);
    }
    else if (shell === "zsh") {
        console.log(`# lizard completion is not yet available for zsh`);
        console.log(`# Coming soon`);
    }
    else if (shell === "fish") {
        console.log(`# lizard completion is not yet available for fish`);
        console.log(`# Coming soon`);
    }
});
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