import chalk from "chalk";
import * as p from "@clack/prompts";
import { Command } from "commander";
import { api, APIError } from "../lib/api.js";
import { success, isJSONMode, printJSON, table, isTTY, info } from "../lib/format.js";

/**
 * Domains bought on Lizard (lizard.build/domains): `lizard domain owned` lists them,
 * `lizard domain dns <domain>` reads and edits their DNS records, and `lizard domain
 * <hostname>` on one of them (or a subdomain) sets the DNS itself instead of printing
 * records to add. These endpoints take a login or an unscoped API key, never a scoped one.
 */

export interface OwnedDomain {
  id: string;
  domain: string;
  status: string;
  appId: string | null;
  expiresAt: number | null;
}

type DnsType = "A" | "AAAA" | "CNAME" | "ALIAS" | "MX" | "TXT" | "URL301";
interface DnsRecord { name: string; type: DnsType; value: string; ttl: number; priority?: number }
const DNS_TYPES: DnsType[] = ["A", "AAAA", "CNAME", "ALIAS", "MX", "TXT", "URL301"];

const SESSION_HINT = "Domains bought on Lizard need `lizard login` or an API key without scopes (a scoped key cannot reach them).";

async function listOwned(): Promise<OwnedDomain[]> {
  const r = await api.get<{ orders: OwnedDomain[] }>("/api/domains/orders").catch((err: unknown) => {
    if (err instanceof APIError && err.status === 401) throw new Error(SESSION_HINT);
    throw err;
  });
  return r.orders ?? [];
}

/** The bought domain `hostname` is, or is a subdomain of; null when none (or the
 *  token cannot see bought domains, e.g. an API key). */
export async function findOwnedDomain(hostname: string): Promise<OwnedDomain | null> {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  const orders = await api.get<{ orders: OwnedDomain[] }>("/api/domains/orders").then((r) => r.orders ?? []).catch(() => []);
  return orders
    .filter((o) => o.status === "registered" && (host === o.domain || host.endsWith(`.${o.domain}`)))
    .sort((a, b) => b.domain.length - a.domain.length)[0] ?? null;
}

/** Points `hostname` (the bought domain, or a subdomain of it) at a service: DNS and attach in one call. */
export async function connectOwned(order: OwnedDomain, hostname: string, service: { id: string; name: string }) {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  const r = await api.post<{ ok: boolean; attached: string[]; note?: string }>(
    `/api/domains/orders/${encodeURIComponent(order.id)}/connect`,
    { appId: service.id, hostname: host },
  );
  if (isJSONMode()) {
    printJSON({ ...r, domain: order.domain, hostname: host, service: service.name });
    return;
  }
  success(`${r.attached.map((h) => chalk.cyan(h)).join(" and ")} now point at ${service.name}`);
  console.log(chalk.dim(`  DNS records on ${order.domain} were set for you. ${r.note ?? "HTTPS follows on its own."}`));
}

async function ownedByName(domain: string): Promise<OwnedDomain> {
  const d = domain.toLowerCase().replace(/\.$/, "");
  const all = await listOwned();
  const o = all.find((x) => x.domain === d);
  if (!o) {
    const names = all.filter((x) => x.status === "registered").map((x) => x.domain);
    throw new Error(
      `${d} is not a domain you bought on Lizard.` +
        (names.length ? ` Yours: ${names.join(", ")}` : " Buy one at https://lizard.build/domains"),
    );
  }
  if (o.status !== "registered") throw new Error(`${d} is not registered yet (status: ${o.status})`);
  return o;
}

/** "@", "api", or "api.example.com" -> the name relative to the domain. */
export function relativeName(name: string, domain: string): string {
  const n = name.toLowerCase().replace(/\.$/, "");
  if (n === "@" || n === domain) return "@";
  if (n.endsWith(`.${domain}`)) return n.slice(0, -(domain.length + 1));
  return n;
}

export function parseType(raw: string): DnsType {
  const t = raw.toUpperCase();
  if (t === "REDIRECT") return "URL301";
  if (!(DNS_TYPES as string[]).includes(t)) {
    throw new Error(`Unknown record type "${raw}". Use one of: ${DNS_TYPES.join(", ")} (redirect = URL301)`);
  }
  return t as DnsType;
}

function printRecords(domain: string, records: DnsRecord[]) {
  if (!records.length) {
    info(`${domain} has no DNS records. Add one: lizard domain dns ${domain} set <name> <type> <value>`);
    return;
  }
  table(
    ["NAME", "TYPE", "VALUE", "TTL"],
    records.map((r) => [r.name, r.type === "URL301" ? "REDIRECT" : r.type, r.priority != null ? `${r.priority} ${r.value}` : r.value, String(r.ttl)]),
  );
}

export function registerOwnedDomainCommands(dom: Command) {
  dom
    .command("owned")
    .alias("bought")
    .description("List the domains you bought on Lizard")
    .action(async () => {
      const orders = await listOwned();
      if (isJSONMode()) return printJSON({ domains: orders });
      if (!orders.length) {
        info("You have not bought a domain on Lizard yet: https://lizard.build/domains");
        return;
      }
      table(
        ["DOMAIN", "STATUS", "EXPIRES", "APP"],
        orders.map((o) => [
          o.domain,
          o.status,
          o.expiresAt ? new Date(o.expiresAt).toISOString().slice(0, 10) : "-",
          o.appId ? "connected" : "-",
        ]),
      );
      console.log(chalk.dim("  Point one at a service:  lizard domain <domain or sub.domain> --service <svc>"));
      console.log(chalk.dim("  Edit its DNS records:    lizard domain dns <domain>"));
    });

  dom
    .command("dns")
    .argument("<domain>", "A domain you bought on Lizard")
    .argument("[action]", "set | add | rm (omit to list the records)")
    .argument("[args...]", "set/add: <name> <type> <value>; rm: <name> [type] [value]")
    .description("Show or change the DNS records of a domain you bought on Lizard")
    .option("--ttl <seconds>", "TTL for set/add (default 1800)", (v) => parseInt(v, 10))
    .option("--priority <n>", "MX priority (default 10)", (v) => parseInt(v, 10))
    .option("-y, --yes", "Skip the confirmation for rm")
    .addHelpText(
      "after",
      `
Examples:
  lizard domain dns example.com                                   list the records
  lizard domain dns example.com set api CNAME myapp.onlizard.com  replace api's CNAME
  lizard domain dns example.com set @ A 203.0.113.10
  lizard domain dns example.com add @ MX mail.example.com --priority 10
  lizard domain dns example.com add @ TXT "v=spf1 include:_spf.google.com ~all"
  lizard domain dns example.com set old redirect https://example.com
  lizard domain dns example.com rm api CNAME

set replaces every record of that name and type; add keeps the existing ones (several MX or TXT).
To point a name at a Lizard service, use: lizard domain api.example.com --service <svc>`,
    )
    .action(async (domain: string, action: string | undefined, args: string[], opts: { ttl?: number; priority?: number; yes?: boolean }) => {
      const order = await ownedByName(domain);
      const path = `/api/domains/orders/${encodeURIComponent(order.id)}/dns`;
      const current = await api.get<{ domain: string; records: DnsRecord[]; version: string }>(path);

      if (!action || action === "list" || action === "ls") {
        if (isJSONMode()) return printJSON(current);
        printRecords(order.domain, current.records);
        return;
      }

      let records: DnsRecord[];
      let summary: string;
      if (action === "set" || action === "add") {
        if (args.length < 3) throw new Error(`Usage: lizard domain dns ${order.domain} ${action} <name> <type> <value>`);
        const name = relativeName(args[0], order.domain);
        const type = parseType(args[1]);
        const value = args.slice(2).join(" ");
        const rec: DnsRecord = { name, type, value, ttl: opts.ttl ?? 1800 };
        if (type === "MX") rec.priority = opts.priority ?? 10;
        const kept = action === "set" ? current.records.filter((r) => !(r.name === name && r.type === type)) : current.records;
        records = [...kept, rec];
        summary = `${action === "set" ? "Set" : "Added"} ${type === "URL301" ? "REDIRECT" : type} ${name} -> ${value}`;
      } else if (action === "rm" || action === "remove" || action === "delete") {
        if (args.length < 1) throw new Error(`Usage: lizard domain dns ${order.domain} rm <name> [type] [value]`);
        const name = relativeName(args[0], order.domain);
        const type = args[1] ? parseType(args[1]) : null;
        const value = args.length > 2 ? args.slice(2).join(" ") : null;
        const match = (r: DnsRecord) => r.name === name && (!type || r.type === type) && (value === null || r.value === value);
        const gone = current.records.filter(match);
        if (!gone.length) throw new Error(`No record matches ${[name, type, value].filter(Boolean).join(" ")} on ${order.domain}`);
        if (!opts.yes) {
          if (!isTTY()) throw new Error("Use -y to confirm in non-interactive mode");
          printRecords(order.domain, gone);
          const ok = await p.confirm({ message: `Remove ${gone.length === 1 ? "this record" : `these ${gone.length} records`} from ${order.domain}?` });
          if (p.isCancel(ok) || !ok) process.exit(5);
        }
        records = current.records.filter((r) => !match(r));
        summary = `Removed ${gone.length} record${gone.length === 1 ? "" : "s"}`;
      } else {
        throw new Error(`Unknown action "${action}". Use set, add or rm (or nothing to list).`);
      }

      const saved = await api.put<{ records: DnsRecord[]; version: string }>(path, { version: current.version, records });
      if (isJSONMode()) return printJSON({ domain: order.domain, ...saved });
      success(`${summary} on ${order.domain}`);
      printRecords(order.domain, saved.records);
      console.log(chalk.dim("  Changes reach most resolvers within minutes (up to the old record's TTL)."));
    });
}
