import chalk from "chalk";
import ora from "ora";
import open from "open";
import * as p from "@clack/prompts";
import { api } from "../lib/api.js";
import { success, info, isJSONMode, printJSON, table, timeAgo } from "../lib/format.js";
// Built-in coding agents (platform: server/src/routes/agents.ts), Boat-style.
//
//   lizard agents login codex        connect your ChatGPT (device code) for this project
//   lizard agents status             what is connected
//   lizard agents logout codex
//   lizard sandbox prompt <id> "…"   run Codex in a sandbox and stream what it does
//   lizard sandbox conversations <id>
//   lizard sandbox interrupt <id>
//
// Credentials belong to your account: connect once, every sandbox can run agents on them. The platform keeps the refresh token and hands a sandbox only a short-lived access
// token per run.
// Agents that can run today; the platform lists the rest as coming (GET /agents).
const PROVIDERS = ["codex", "claude", "pi", "opencode", "prime"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Short names for the credential pool. "codex" is the old name of the ChatGPT login.
const KIND_ALIASES = {
    chatgpt: "chatgpt", codex: "chatgpt", claude: "claude", kimi: "kimi",
    openai: "openai_key", anthropic: "anthropic_key", openrouter: "openrouter_key",
    llmgateway: "llmgateway_key", deepseek: "deepseek_key", moonshot: "moonshot_key",
};
const kindOf = (name) => {
    const k = KIND_ALIASES[name] ?? (Object.values(KIND_ALIASES).includes(name) ? name : null);
    if (!k)
        throw new Error(`Unknown credential '${name}'. Use one of: ${Object.keys(KIND_ALIASES).filter((x) => x !== "codex").join(", ")}.`);
    return k;
};
function checkProvider(p) {
    if (!PROVIDERS.includes(p))
        throw new Error(`Unknown agent '${p}'. Available: ${PROVIDERS.join(", ")}.`);
}
async function showPool() {
    const r = await api.get("/api/agents");
    if (isJSONMode())
        return printJSON(r);
    const label = (k) => r.credentials.find((c) => c.kind === k)?.label ?? k;
    info(chalk.bold("Credentials") + chalk.dim("  — connect once, every agent that accepts it can use it"));
    table(["Credential", "Status", "Account"], r.credentials.map((c) => [
        c.label, c.connected ? chalk.green("connected") : c.status === "reauth_required" ? chalk.yellow("sign in again") : chalk.dim("—"),
        c.connected ? [c.account, c.plan].filter(Boolean).join(" · ") || "" : "",
    ]));
    info("");
    info(chalk.bold("Agents"));
    table(["Agent", "Uses", "Accepts", "Default model"], r.harnesses.map((h) => [
        h.available ? h.label : chalk.dim(`${h.label} (coming soon)`),
        h.ready ? chalk.green(h.activeCredentials.map(label).join(" + ")) : h.available ? chalk.yellow("no credential") : chalk.dim("—"),
        chalk.dim(`${h.mode === "one" ? "one of" : "any of"}: ${h.accepts.map(label).join(", ")}`),
        [h.defaultModel, h.defaultEffort].filter(Boolean).join(" · ") || chalk.dim("agent default"),
    ]));
}
export function registerAgents(program) {
    const ag = program.command("agents")
        .description("Coding agents in sandboxes: your account's credentials (ChatGPT, Claude, API keys) and per-agent defaults")
        .option("-p, --project <id>", "Ignored: agent credentials belong to your account")
        .action(async (opts) => showPool());
    ag.command("status")
        .option("-p, --project <id>", "Ignored: agent credentials belong to your account")
        .description("Show connected credentials and which agents can run")
        .action(async (opts) => showPool());
    ag.command("login")
        .argument("[credential]", "Subscription to sign in to (chatgpt)", "chatgpt")
        .option("-p, --project <id>", "Ignored: agent credentials belong to your account")
        .option("--open", "Open the sign-in page in your browser")
        .description("Sign in to your ChatGPT subscription with a device code (used by Codex)")
        .action(async (name, opts) => {
        const kind = kindOf(name);
        if (kind === "claude")
            throw new Error("Claude subscriptions are added with a token: run `claude setup-token`, then `lizard agents add claude`.");
        if (kind !== "chatgpt")
            throw new Error(`'${name}' is added with \`lizard agents add ${name}\`.`);
        const start = await api.post(`/api/agents/credentials/chatgpt/login`, {});
        if (isJSONMode())
            printJSON(start);
        else {
            info(`1. Open ${chalk.bold(start.verificationUrl)} and sign in to ChatGPT`);
            info(`2. Enter the code ${chalk.bold.cyan(start.userCode)}  ${chalk.dim("(expires in 15 minutes)")}`);
            info(chalk.dim("   Only enter it if you started this login yourself."));
        }
        if (opts.open)
            await open(start.verificationUrl).catch(() => { });
        const spinner = isJSONMode() ? null : ora("Waiting for you to approve…").start();
        for (;;) {
            await sleep(Math.max(2, start.interval) * 1000);
            const r = await api.get(`/api/agents/credentials/chatgpt/login/${start.loginId}`).catch((e) => { spinner?.stop(); throw e; });
            if (r.status === "pending")
                continue;
            spinner?.stop();
            if (r.status === "connected") {
                if (isJSONMode())
                    printJSON(r);
                else
                    success(`ChatGPT connected${r.email ? ` as ${r.email}` : ""}${r.plan ? ` (${r.plan})` : ""}.`);
                return;
            }
            throw new Error("The code expired before it was approved. Run `lizard agents login` again.");
        }
    });
    ag.command("add")
        .argument("<credential>", "claude | anthropic | openai | openrouter | llmgateway | deepseek | moonshot")
        .option("-p, --project <id>", "Ignored: agent credentials belong to your account")
        .option("--key <value>", "The key or token (otherwise read from stdin, or asked for)")
        .description("Add an API key, or a Claude subscription token from `claude setup-token`")
        .action(async (name, opts) => {
        const kind = kindOf(name);
        if (kind === "chatgpt")
            throw new Error("ChatGPT is added by signing in: `lizard agents login chatgpt`.");
        let key = opts.key;
        if (!key && !process.stdin.isTTY)
            key = (await new Promise((res) => { let d = ""; process.stdin.on("data", (c) => (d += c)); process.stdin.on("end", () => res(d)); })).trim();
        if (!key) {
            if (kind === "claude")
                info(chalk.dim("Run `claude setup-token` on your machine and paste the token it prints (sk-ant-oat01-…)."));
            const v = await p.password({ message: `${name === "claude" ? "Claude subscription token" : `${name} API key`}:` });
            if (p.isCancel(v))
                return;
            key = String(v).trim();
        }
        const r = await api.put(`/api/agents/credentials/${kind}`, { apiKey: key });
        if (isJSONMode())
            printJSON(r);
        else
            success(`Added ${name} (${r.account}).`);
    });
    ag.command("remove")
        .alias("logout")
        .argument("<credential>", "chatgpt | claude | anthropic | openai | openrouter | llmgateway | deepseek | moonshot")
        .option("-p, --project <id>", "Ignored: agent credentials belong to your account")
        .description("Remove a credential from this project")
        .action(async (name, opts) => {
        const kind = kindOf(name);
        await api.delete(`/api/agents/credentials/${kind}`);
        if (isJSONMode())
            printJSON({ kind, disconnected: true });
        else
            success(`Removed ${name}.`);
    });
    ag.command("use")
        .argument("<agent>", "codex | claude | pi | opencode | prime | kimi")
        .option("-p, --project <id>", "Ignored: agent credentials belong to your account")
        .option("--credential <name>", "For Codex / Claude Code: which credential to use")
        .option("-m, --model <model>", "Default model (\"none\" to clear)")
        .option("--effort <level>", "Default reasoning effort (\"none\" to clear)")
        .description("Set an agent's credential and default model/effort")
        .action(async (agent, opts) => {
        const body = {};
        if (opts.credential)
            body.authKind = kindOf(opts.credential);
        if (opts.model)
            body.defaultModel = opts.model === "none" ? null : opts.model;
        if (opts.effort)
            body.defaultEffort = opts.effort === "none" ? null : opts.effort;
        if (!Object.keys(body).length)
            throw new Error("Nothing to set: pass --credential, --model or --effort.");
        const r = await api.put(`/api/agents/harnesses/${agent}`, body);
        if (isJSONMode())
            printJSON(r);
        else
            success(`Updated ${agent}.`);
    });
}
function render(e, verbose) {
    switch (e.type) {
        case "running":
            if (e.detail)
                info(chalk.dim(`… ${e.detail}`));
            break;
        case "queued":
            info(chalk.dim("… queued behind the turn already running in this conversation"));
            break;
        case "tool_call":
            if (e.tool === "command_execution")
                info(chalk.dim(`$ ${e.input ?? ""}`));
            else
                info(chalk.dim(`• ${e.tool}${e.input ? `: ${e.input}` : ""}`));
            break;
        case "tool_result":
            if (typeof e.exitCode === "number" && e.exitCode !== 0)
                info(chalk.yellow(`  exit ${e.exitCode}`));
            if (verbose && e.output)
                info(chalk.dim(e.output.trimEnd().split("\n").map((l) => `  ${l}`).join("\n")));
            break;
        case "response":
            process.stdout.write(`\n${e.text ?? ""}\n\n`);
            break;
    }
}
export function registerSandboxAgentCommands(sb) {
    sb.command("prompt")
        .argument("<id>", "Sandbox ID")
        .argument("<prompt...>", "What the agent should do")
        .option("--agent <provider>", `Agent (${PROVIDERS.join(", ")})`, "codex")
        .option("-c, --conversation <id>", "Continue this conversation")
        .option("--new", "Start a new conversation")
        .option("-m, --model <model>", "Model to use")
        .option("--effort <level>", "Reasoning effort (minimal, low, medium, high, xhigh)")
        .option("--cwd <dir>", "Working directory in the sandbox", "/workspace")
        .option("-v, --verbose", "Also print command output")
        .option("--no-wait", "Return once the prompt is accepted")
        .description("Run a coding agent in the sandbox and stream what it does")
        .addHelpText("after", `
Runs on your own credentials for the sandbox's project (see \`lizard agents\`).
Use a sandbox created with \`-t codex\`. Ctrl-C stops watching; the agent keeps working —
stop it with \`lizard sandbox interrupt <id>\`.

Examples:
  lizard sandbox prompt sb_abc123 "add a health check endpoint and test it"
  lizard sandbox prompt sb_abc123 -c conv_0123456789abcdef "now add a README section"`)
        .action(async (id, words, opts) => {
        checkProvider(opts.agent);
        const body = { prompt: words.join(" "), provider: opts.agent, cwd: opts.cwd };
        if (opts.conversation)
            body.conversationId = opts.conversation;
        if (opts.new)
            body.new = true;
        if (opts.model)
            body.model = opts.model;
        if (opts.effort)
            body.reasoningEffort = opts.effort;
        const started = await api.post(`/api/sandboxes/${id}/prompt`, body);
        if (!opts.wait)
            return isJSONMode() ? printJSON(started) : success(`Prompt ${started.promptId} ${started.status} in ${started.conversationId}`);
        if (!isJSONMode())
            info(chalk.dim(`${opts.agent} · ${started.conversationId}`));
        process.once("SIGINT", () => {
            if (!isJSONMode())
                info(chalk.dim(`\nStopped watching; the agent keeps working. Stop it: lizard sandbox interrupt ${id} -c ${started.conversationId}`));
            process.exit(130);
        });
        let after = 0;
        for (;;) {
            const r = await api.get(`/api/sandboxes/${id}/events?after=${after}&conversationId=${started.conversationId}&limit=500`);
            after = r.next ?? after;
            for (const e of r.events) {
                if (e.promptId !== started.promptId)
                    continue;
                if (isJSONMode()) {
                    process.stdout.write(JSON.stringify(e) + "\n");
                }
                else
                    render(e, !!opts.verbose);
                if (e.type === "finished") {
                    if (!isJSONMode()) {
                        const u = e.usage ? chalk.dim(` · ${e.usage.input_tokens ?? 0} in / ${e.usage.output_tokens ?? 0} out tokens${typeof e.usage.cost_usd === "number" ? ` · $${e.usage.cost_usd.toFixed(4)}` : ""}`) : "";
                        success(`Done${u}`);
                        info(chalk.dim(`Continue: lizard sandbox prompt ${id} -c ${started.conversationId} "…"`));
                    }
                    return;
                }
                if (e.type === "failed")
                    throw new Error(e.error ?? "The agent failed");
                if (e.type === "interrupted") {
                    if (!isJSONMode())
                        info(chalk.yellow("Interrupted."));
                    process.exit(130);
                }
            }
            await sleep(r.events.length ? 300 : 1000);
        }
    });
    sb.command("conversations")
        .argument("<id>", "Sandbox ID")
        .description("List agent conversations in a sandbox, newest first")
        .action(async (id) => {
        const r = await api.get(`/api/sandboxes/${id}/conversations`);
        if (isJSONMode())
            return printJSON(r);
        if (!r.conversations.length)
            return info(`No conversations yet. Start one: lizard sandbox prompt ${id} "…"`);
        table(["Conversation", "Agent", "Prompts", "State", "Updated", "Started with"], r.conversations.map((c) => [
            c.id, c.provider, String(c.prompts), c.running ? chalk.green("running") : "idle", timeAgo(c.updatedAt), c.preview.slice(0, 50),
        ]));
    });
    sb.command("interrupt")
        .argument("<id>", "Sandbox ID")
        .option("-c, --conversation <id>", "Only this conversation (default: every running one)")
        .description("Stop the agent's running turn (and anything queued behind it)")
        .action(async (id, opts) => {
        const r = await api.post(`/api/sandboxes/${id}/interrupt`, opts.conversation ? { conversationId: opts.conversation } : {});
        if (isJSONMode())
            return printJSON(r);
        success(r.interrupted.length ? `Interrupted ${r.interrupted.join(", ")}` : "Nothing was running.");
    });
}
//# sourceMappingURL=agents.js.map