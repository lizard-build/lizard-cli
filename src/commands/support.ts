import chalk from "chalk";
import { Command, Option } from "commander";
import { api } from "../lib/api.js";
import { getProjectLink } from "../lib/config.js";
import { fail, isJSONMode, printJSON, table, timeAgo } from "../lib/format.js";
import { agentName, ticketContext } from "../lib/support.js";

/** AGENT_SUPPORT=0 turns off agent-opened tickets on this machine (support.md proposal 4.4). A person
 *  typing the command is not an agent, so it still works for them. */
function agentSupportOff(): boolean {
  return process.env.AGENT_SUPPORT === "0" && !!agentName();
}

interface TicketView { id: string; type: string; subject: string; status: string; source: string; createdAt: string; updatedAt: string; unread: number }

const TYPES = ["bug", "limits", "billing", "question"];

function joinMessage(words: string[]): string {
  const m = words.join(" ").trim();
  if (!m) fail("Write what happened, e.g. lizard support open \"sandbox create in eu returns 500 since 10:00\"", 1, "MISSING_MESSAGE");
  return m;
}

export function registerSupport(program: Command) {
  const support = program
    .command("support")
    .description("Tickets to the Lizard team: something on Lizard is broken, or you need higher limits / a bigger plan. Replies appear after your next lizard command.");

  support
    .command("open")
    .description("Open a ticket. Your last failed Lizard calls, CLI version and OS are attached automatically.")
    .argument("<message...>", "What you did, what happened, what you expected")
    .addOption(new Option("-t, --type <type>", "bug | limits | billing | question").choices(TYPES).default("bug"))
    .option("--sandbox <id>", "The sandbox this is about (its state is attached)")
    .option("--app <name-or-id>", "The app this is about (its state is attached)")
    .option("--expected <text>", "What should have happened")
    .option("--actual <text>", "What happened instead (the exact error)")
    .option("--repro <text>", "Shortest steps or commands that show it")
    .action(async (words: string[], opts: { type: string; sandbox?: string; app?: string; expected?: string; actual?: string; repro?: string }) => {
      if (agentSupportOff()) fail("Agent support tickets are turned off on this machine (AGENT_SUPPORT=0). Tell the user what failed instead.", 1, "AGENT_SUPPORT_OFF");
      const message = joinMessage(words);
      const link = getProjectLink();
      const res = await api.post<TicketView & { similarId?: string; similarCount?: number; note?: string }>("/api/support/tickets", {
        message,
        type: opts.type,
        source: "cli",
        agent: agentName(),
        sandboxId: opts.sandbox,
        appId: opts.app,
        expected: opts.expected,
        actual: opts.actual,
        repro: opts.repro,
        workspaceId: link?.workspaceId ?? undefined,
        context: ticketContext(),
      });
      if (isJSONMode()) return printJSON(res);
      console.log(chalk.green("✓") + ` ${res.similarId ? "Already open as" : "Opened"} ${chalk.bold(res.id)} — ${res.subject}`);
      if (res.note) console.log(chalk.dim(res.note));
    });

  support
    .command("list")
    .alias("ls")
    .description("Your tickets, newest activity first")
    .action(async () => {
      const { tickets } = await api.get<{ tickets: TicketView[] }>("/api/support/tickets");
      if (isJSONMode()) return printJSON(tickets);
      if (!tickets.length) return console.log("No tickets.");
      table(["Ticket", "Type", "Status", "Updated", "Subject"], tickets.map((t) => [
        t.unread ? chalk.green(`${t.id} •${t.unread} new`) : t.id, t.type, t.status, timeAgo(t.updatedAt), t.subject,
      ]));
    });

  support
    .command("show")
    .description("A ticket with every message; marks support's replies as read")
    .argument("<ticket>", "Ticket id, e.g. T-1043")
    .action(async (ref: string) => {
      const t = await api.get<TicketView & { messages: Array<{ from: string; body: string; at: string }> }>(
        `/api/support/tickets/${encodeURIComponent(ref)}`);
      if (isJSONMode()) return printJSON(t);
      console.log(chalk.bold(`${t.id} · ${t.type} · ${t.status}`) + chalk.dim(`  opened ${timeAgo(t.createdAt)}`));
      for (const m of t.messages) {
        console.log("");
        console.log((m.from === "you" ? chalk.cyan(m.from) : chalk.green(m.from)) + chalk.dim(`  ${timeAgo(m.at)}`));
        console.log(m.body);
      }
      console.log("");
      console.log(chalk.dim(`Answer: lizard support reply ${t.id} "…"`));
    });

  support
    .command("reply")
    .description("Add to a ticket: answer support's question, or add new details")
    .argument("<ticket>", "Ticket id, e.g. T-1043")
    .argument("<message...>", "Your answer")
    .action(async (ref: string, words: string[]) => {
      const res = await api.post<{ ok: boolean; ticket: string }>(
        `/api/support/tickets/${encodeURIComponent(ref)}/messages`, { message: joinMessage(words) });
      if (isJSONMode()) return printJSON(res);
      console.log(chalk.green("✓") + ` Sent to the Lizard team on ${res.ticket}`);
    });
}
