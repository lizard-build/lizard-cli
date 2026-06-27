#!/usr/bin/env node

import { Command } from "commander";
import chalk from "chalk";
import { setJSONMode, isJSONMode, error } from "./lib/format.js";
import { requireAuth, isLoggedIn } from "./lib/auth.js";
import { setBaseURL, setAccessToken, APIError, isProjectDeletedError } from "./lib/api.js";
import { checkForUpdateInBackground, runBackgroundUpdate, CURRENT_VERSION } from "./lib/updater.js";

const BANNER = chalk.rgb(16, 185, 129)(
  [
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
  ].join("\n"),
);

// Pointer shown at the top of `lizard --help` (and mirrored in the --help --json
// schema dump). Steers AI agents to the version-matched embedded skill instead
// of guessing commands from flag docs alone.
const AGENTS_HELP = [
  chalk.bold("Start here (for AI agents):"),
  "  " + chalk.cyan("lizard skills get core"),
  "",
  chalk.dim(
    "  Skills ship with the CLI (always version-matched) and cover the full app",
  ),
  chalk.dim(
    "  lifecycle — deploy, link, addons, logs, scaling, secrets, domains — with",
  ),
  chalk.dim(
    "  copy-paste examples. Prefer this over guessing commands from flag docs alone.",
  ),
].join("\n");

// Compact form of the same pointer, shown on every subcommand's `--help` so the
// per-command flag docs never read as the whole story. Mirrors the `agents`
// block that `--help --json` already emits for every command; one tight line so
// it sits above a subcommand's Usage without crowding it.
const AGENTS_HELP_COMPACT =
  chalk.bold("For AI agents:") +
  " run " +
  chalk.cyan("lizard skills get core") +
  chalk.dim(" for version-matched usage and examples.");

/** Attach the compact agents pointer to every (nested) subcommand's help. */
function addAgentsPointerToSubcommands(cmd: Command) {
  for (const sub of cmd.commands) {
    sub.addHelpText("before", AGENTS_HELP_COMPACT + "\n");
    addAgentsPointerToSubcommands(sub);
  }
}

// Commands (alphabetical by command name)
import { registerAdd } from "./commands/add.js";
import { registerConfig } from "./commands/config.js";
import { registerDocs } from "./commands/docs.js";
import { registerDomain } from "./commands/domain.js";
import { registerEvents } from "./commands/events.js";
import { registerGit } from "./commands/git.js";
import { registerInit } from "./commands/init.js";
import { registerLink } from "./commands/link.js";
import { registerLogin } from "./commands/login.js";
import { registerLogout } from "./commands/logout.js";
import { registerLogs } from "./commands/logs.js";
import { registerMetrics } from "./commands/metrics.js";
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
import { registerSkill } from "./commands/skill.js";
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
  .addHelpText("before", BANNER + "\n\n" + AGENTS_HELP + "\n")
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
    // Walk up to the top-level ancestor so subcommands inherit (`skills list`
    // matches via `skills`). Leaf names like `git status` don't false-positive
    // because we check the ancestor's name, not the action's.
    const noAuth = new Set(["login", "logout", "upgrade", "help", "docs", "status", "skills"]);
    let topLevel: Command = actionCommand;
    while (topLevel.parent && topLevel.parent !== thisCommand) {
      topLevel = topLevel.parent;
    }
    if (noAuth.has(topLevel.name())) return;

    // Require auth — auto-triggers login flow if not logged in
    const creds = await requireAuth();
    setAccessToken(creds.accessToken);
  });

// Throw instead of process.exit so the catch in main() can emit JSON error
// envelopes. Must run BEFORE command registration: commander copies inherited
// settings (including the exit callback) at .command() creation time, so
// subcommands registered earlier would still process.exit() directly and
// bypass the JSON contract (empty stdout on `lizard up status --json` etc.).
program.exitOverride();

// Register all commands (alphabetical)
registerAdd(program);
registerConfig(program);
registerDocs(program);
registerDomain(program);
registerEvents(program);
registerGit(program);
registerInit(program);
registerLink(program);
registerLogin(program);
registerLogout(program);
registerLogs(program);
registerMetrics(program);
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
registerSkill(program);
registerSSH(program);
registerStatus(program);
registerUnlink(program);
registerUp(program);
registerUpgrade(program);
registerWhoami(program);
registerWorkspace(program);

// Root help already carries the full AGENTS_HELP block; mirror a compact pointer
// onto every subcommand so `lizard <cmd> --help` matches `--help --json` parity.
addAgentsPointerToSubcommands(program);

const EXIT_CODES: Record<string, string> = {
  "0": "success",
  "1": "generic error",
  "2": "auth (401/403)",
  "3": "not found (404)",
  "4": "timeout (408/504)",
  "5": "cancelled by user",
};

function isHelpJsonRequest(argv: string[]): boolean {
  const hasJson = argv.some((a) => a === "--json");
  if (!hasJson) return false;
  if (argv.some((a) => a === "--help" || a === "-h")) return true;
  // `lizard help [cmd] --json` — the built-in help command otherwise ignores
  // --json and prints the banner. Treat it as a schema-dump request too.
  const firstPositional = argv.slice(2).find((a) => !a.startsWith("-"));
  return firstPositional === "help";
}

/**
 * Drop the leading `help` command token (commander's built-in) so target
 * resolution sees the command the user actually asked about
 * (`lizard help service set --json` → resolve `service set`).
 */
function stripHelpToken(argv: string[]): string[] {
  const out = argv.slice();
  for (let i = 2; i < out.length; i++) {
    if (out[i].startsWith("-")) continue;
    if (out[i] === "help") out.splice(i, 1);
    break;
  }
  return out;
}

function collectValueFlags(cmd: Command, acc: Set<string>) {
  for (const opt of cmd.options as any[]) {
    if (opt.required || opt.optional) {
      if (opt.short) acc.add(opt.short);
      if (opt.long) acc.add(opt.long);
    }
  }
  for (const sub of cmd.commands) collectValueFlags(sub, acc);
}

function findTargetCommand(
  argv: string[],
  root: Command,
): { target: Command; unknown: string | null } {
  const valueFlags = new Set<string>();
  collectValueFlags(root, valueFlags);

  let cur: Command = root;
  for (let i = 2; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === "--help" || tok === "-h" || tok === "--json") continue;
    if (tok.startsWith("-")) {
      if (tok.includes("=")) continue;
      if (valueFlags.has(tok) && i + 1 < argv.length) i++;
      continue;
    }
    const sub = cur.commands.find(
      (c) => c.name() === tok || c.aliases().includes(tok),
    );
    if (!sub) {
      // Token isn't a subcommand. If `cur` takes positional arguments it's one
      // of those (`domain <hostname>`, `scale <service>`) — return cur's
      // schema. Otherwise it's an unknown command (the root has no positionals,
      // so `lizard deploy` lands here) — flag it so the caller errors instead
      // of silently dumping the root schema with exit 0.
      const acceptsArgs = ((cur as any).registeredArguments ?? []).length > 0;
      return { target: cur, unknown: acceptsArgs ? null : tok };
    }
    cur = sub;
  }
  return { target: cur, unknown: null };
}

function dumpOption(o: any) {
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

function dumpCommand(cmd: Command): any {
  const args = ((cmd as any).registeredArguments ?? []).map((a: any) => ({
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
    options: (cmd.options as any[])
      .filter((o) => !o.hidden)
      .map(dumpOption),
    subcommands: cmd.commands
      .filter((c: any) => !c._hidden)
      .map(dumpCommand),
  };
}

async function main() {
  // Hidden entry point: detached child spawned by checkForUpdateInBackground.
  // Handled before commander so it never shows up in help or telemetry.
  if (process.argv.includes("__lizard-update")) {
    await runBackgroundUpdate();
    process.exit(0);
  }

  // Set JSON mode from argv *before* parseAsync so the catch block below
  // honors --json even when commander rejects before our preAction hook
  // fires (e.g. unknown command, malformed global flag). Non-TTY auto-mode
  // stays in preAction — `lizard --help | less` shouldn't suddenly emit JSON.
  if (process.argv.includes("--json")) {
    setJSONMode(true);
  }

  // `lizard --version --json` — commander handles -V/--version itself with a
  // raw string; agents asking for JSON should get JSON.
  if (
    process.argv.includes("--json") &&
    (process.argv.includes("--version") || process.argv.includes("-V"))
  ) {
    process.stdout.write(
      JSON.stringify({ cli: "lizard", version: CURRENT_VERSION }, null, 2) + "\n",
    );
    process.exit(0);
  }

  if (isHelpJsonRequest(process.argv)) {
    const { target, unknown } = findTargetCommand(
      stripHelpToken(process.argv),
      program,
    );
    if (unknown) {
      process.stdout.write(
        JSON.stringify(
          {
            error: {
              code: "UNKNOWN_COMMAND",
              status: null,
              message: `Unknown command '${unknown}'. Run \`lizard --help --json\` to list available commands.`,
              body: null,
            },
          },
          null,
          2,
        ) + "\n",
      );
      process.exit(3);
    }
    const isRoot = target === program;
    const out = {
      cli: "lizard",
      version: CURRENT_VERSION,
      agents: {
        start: "lizard skills get core",
        note: "Skills ship with this CLI version and cover the full app lifecycle (deploy, link, addons, logs, scaling, secrets, domains) with copy-paste examples. Prefer this over guessing commands from flag docs alone.",
      },
      command: dumpCommand(target),
      globalOptions: isRoot
        ? []
        : (program.options as any[]).filter((o) => !o.hidden).map(dumpOption),
      exitCodes: EXIT_CODES,
    };
    process.stdout.write(JSON.stringify(out, null, 2) + "\n");
    process.exit(0);
  }

  try {
    await program.parseAsync(process.argv);
  } catch (err: any) {
    // Commander throws for --help, --version, etc. — ignore those
    if (err.code === "commander.helpDisplayed" || err.code === "commander.version") {
      process.exit(0);
    }

    // Commander usage errors (missing argument, unknown option, bare group
    // command). Commander has already written its message / help text to
    // stderr; in JSON mode also emit a parseable envelope on stdout.
    if (typeof err.code === "string" && err.code.startsWith("commander.")) {
      const exitCode = err.exitCode ?? 1;
      const bareGroup = err.code === "commander.help"; // help({error:true}) — no subcommand given
      if (isJSONMode() && exitCode !== 0) {
        console.log(
          JSON.stringify(
            {
              error: {
                code: bareGroup ? "MISSING_SUBCOMMAND" : err.code,
                status: null,
                message: bareGroup
                  ? "Missing subcommand. Run the command with --help --json to list available subcommands."
                  : err.message || String(err),
                body: null,
              },
            },
            null,
            2,
          ),
        );
      }
      process.exit(exitCode);
    }

    // Project moved to trash: the backend rejects every write to it. Surface a
    // clear next step instead of the raw "Project is being deleted" 409.
    const projectDeleted = isProjectDeletedError(err);
    const msg = projectDeleted
      ? "This project is being deleted — create a new one with `lizard init`."
      : err.message || String(err);
    const apiErr = err instanceof APIError ? err : undefined;
    const status = apiErr?.status;
    const code = projectDeleted ? "PROJECT_DELETED" : apiErr?.code || err.code || "ERROR";

    if (isJSONMode()) {
      console.log(
        JSON.stringify(
          {
            error: {
              code,
              status: status ?? null,
              message: msg,
              body: apiErr?.body ?? null,
            },
          },
          null,
          2,
        ),
      );
    } else {
      error(msg);
      if (status === 401) {
        process.stderr.write("Run `lizard login` to re-authenticate.\n");
      }
    }

    // Exit codes derived from APIError.status (or tagged error codes), not message text
    const isAuth = status === 401 || status === 403 || code === "NOT_AUTHENTICATED";

    const isNotFound = status === 404;
    const isTimeout =
      status === 408 ||
      status === 504 ||
      err.name === "AbortError" ||
      err.code === "ETIMEDOUT" ||
      err.code === "UND_ERR_CONNECT_TIMEOUT";

    if (isAuth) process.exit(2);
    if (isNotFound) process.exit(3);
    if (isTimeout) process.exit(4);
    process.exit(1);
  }
}

main();
