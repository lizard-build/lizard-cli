import chalk from "chalk";
import * as p from "@clack/prompts";
import { api, APIError } from "../lib/api.js";
import { success, isJSONMode, printJSON, table, isTTY, info } from "../lib/format.js";
const DNS_TYPES = ["A", "AAAA", "CNAME", "ALIAS", "MX", "TXT", "URL301"];
const SESSION_HINT = "Domains bought on Lizard need `lizard login` or an API key without scopes (a scoped key cannot reach them).";
/** Changing a bought domain needs a login: an API key can read it but not repoint it, so a
 *  leaked key cannot take the domain or its email. */
const WRITE_HINT = "Changing a domain bought on Lizard needs `lizard login` (an API key can read its records but not change them).";
function writeError(err) {
    if (err instanceof APIError && err.status === 401)
        throw new Error(WRITE_HINT);
    throw err;
}
const POINTING = ["A", "AAAA", "CNAME", "ALIAS", "URL301"];
/** Records connecting `names` would replace, leaving out ones nobody would miss: the
 *  registrar's parking page and a previous Lizard target. */
export function recordsToReplace(records, names) {
    return records.filter((r) => names.includes(r.name) && POINTING.includes(r.type)
        && !/(^|\.)parkingpage\.namecheap\.com\.?$/i.test(r.value) && !/(^|\.)onlizard\.com\.?$/i.test(r.value));
}
async function listOwned() {
    const r = await api.get("/api/domains/orders").catch((err) => {
        if (err instanceof APIError && err.status === 401)
            throw new Error(SESSION_HINT);
        throw err;
    });
    return r.orders ?? [];
}
/** The bought domain `hostname` is, or is a subdomain of; null when none (or the
 *  token cannot see bought domains, e.g. an API key). */
export async function findOwnedDomain(hostname) {
    const host = hostname.toLowerCase().replace(/\.$/, "");
    const orders = await api.get("/api/domains/orders").then((r) => r.orders ?? []).catch(() => []);
    return orders
        .filter((o) => o.status === "registered" && (host === o.domain || host.endsWith(`.${o.domain}`)))
        .sort((a, b) => b.domain.length - a.domain.length)[0] ?? null;
}
/** Points `hostname` (the bought domain, or a subdomain of it) at a service: DNS and attach
 *  in one call. Records it would replace, and a hostname attached to another service, need
 *  a yes at the terminal or --force, so one command cannot quietly take a working site down. */
export async function connectOwned(order, hostname, service, force) {
    const host = hostname.toLowerCase().replace(/\.$/, "");
    const names = host === order.domain ? ["@", "www"] : [host.slice(0, -(order.domain.length + 1))];
    let move = force;
    if (!force) {
        const dns = await api.get(`/api/domains/orders/${encodeURIComponent(order.id)}/dns`);
        const replaced = recordsToReplace(dns.records, names);
        if (replaced.length) {
            const list = replaced.map((r) => `${r.name} ${r.type} ${r.value}`).join(", ");
            if (!isTTY() || isJSONMode())
                throw new Error(`This replaces existing records on ${order.domain}: ${list}. Run again with --force to replace them.`);
            printRecords(order.domain, replaced);
            const ok = await p.confirm({ message: `Replace ${replaced.length === 1 ? "this record" : "these records"} so ${host} points at ${service.name}?` });
            if (p.isCancel(ok) || !ok)
                process.exit(5);
        }
    }
    const connect = (forceMove) => api.post(`/api/domains/orders/${encodeURIComponent(order.id)}/connect`, { appId: service.id, hostname: host, force: forceMove });
    const r = await connect(move).catch(async (err) => {
        if (err instanceof APIError && err.status === 409 && !move && isTTY() && !isJSONMode()) {
            const ok = await p.confirm({ message: `${err.message} Move it to ${service.name}?` });
            if (p.isCancel(ok) || !ok)
                process.exit(5);
            move = true;
            return connect(true).catch(writeError);
        }
        return writeError(err);
    });
    if (isJSONMode()) {
        printJSON({ ...r, domain: order.domain, hostname: host, service: service.name });
        return;
    }
    success(`${r.attached.map((h) => chalk.cyan(h)).join(" and ")} now point at ${service.name}`);
    console.log(chalk.dim(`  DNS records on ${order.domain} were set for you. ${r.note ?? "HTTPS follows on its own."}`));
}
async function ownedByName(domain) {
    const d = domain.toLowerCase().replace(/\.$/, "");
    const all = await listOwned();
    const o = all.find((x) => x.domain === d);
    if (!o) {
        const names = all.filter((x) => x.status === "registered").map((x) => x.domain);
        throw new Error(`${d} is not a domain you bought on Lizard.` +
            (names.length ? ` Yours: ${names.join(", ")}` : " Buy one at https://lizard.build/domains"));
    }
    if (o.status !== "registered")
        throw new Error(`${d} is not registered yet (status: ${o.status})`);
    return o;
}
/** "@", "api", or "api.example.com" -> the name relative to the domain. */
export function relativeName(name, domain) {
    const n = name.toLowerCase().replace(/\.$/, "");
    if (n === "@" || n === domain)
        return "@";
    if (n.endsWith(`.${domain}`))
        return n.slice(0, -(domain.length + 1));
    return n;
}
export function parseType(raw) {
    const t = raw.toUpperCase();
    if (t === "REDIRECT")
        return "URL301";
    if (!DNS_TYPES.includes(t)) {
        throw new Error(`Unknown record type "${raw}". Use one of: ${DNS_TYPES.join(", ")} (redirect = URL301)`);
    }
    return t;
}
function printRecords(domain, records) {
    if (!records.length) {
        info(`${domain} has no DNS records. Add one: lizard domain dns ${domain} set <name> <type> <value>`);
        return;
    }
    table(["NAME", "TYPE", "VALUE", "TTL"], records.map((r) => [r.name, r.type === "URL301" ? "REDIRECT" : r.type, r.priority != null ? `${r.priority} ${r.value}` : r.value, String(r.ttl)]));
}
export function registerOwnedDomainCommands(dom) {
    dom
        .command("owned")
        .alias("bought")
        .description("List the domains you bought on Lizard")
        .action(async () => {
        const orders = await listOwned();
        if (isJSONMode())
            return printJSON({ domains: orders });
        if (!orders.length) {
            info("You have not bought a domain on Lizard yet: https://lizard.build/domains");
            return;
        }
        table(["DOMAIN", "STATUS", "EXPIRES", "APP"], orders.map((o) => [
            o.domain,
            o.status,
            o.expiresAt ? new Date(o.expiresAt).toISOString().slice(0, 10) : "-",
            o.appId ? "connected" : "-",
        ]));
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
        .addHelpText("after", `
Examples:
  lizard domain dns example.com                                   list the records
  lizard domain dns example.com set api CNAME myapp.onlizard.com  replace api's CNAME
  lizard domain dns example.com set @ A 203.0.113.10
  lizard domain dns example.com add @ MX mail.example.com --priority 10
  lizard domain dns example.com add @ TXT "v=spf1 include:_spf.google.com ~all"
  lizard domain dns example.com set old redirect https://example.com
  lizard domain dns example.com rm api CNAME

set replaces every record of that name and type; add keeps the existing ones (several MX or TXT).
To point a name at a Lizard service, use: lizard domain api.example.com --service <svc>`)
        .action(async (domain, action, args, opts) => {
        const order = await ownedByName(domain);
        const path = `/api/domains/orders/${encodeURIComponent(order.id)}/dns`;
        const current = await api.get(path);
        if (!action || action === "list" || action === "ls") {
            if (isJSONMode())
                return printJSON(current);
            printRecords(order.domain, current.records);
            return;
        }
        let records;
        let summary;
        if (action === "set" || action === "add") {
            if (args.length < 3)
                throw new Error(`Usage: lizard domain dns ${order.domain} ${action} <name> <type> <value>`);
            const name = relativeName(args[0], order.domain);
            const type = parseType(args[1]);
            const value = args.slice(2).join(" ");
            const rec = { name, type, value, ttl: opts.ttl ?? 1800 };
            if (type === "MX")
                rec.priority = opts.priority ?? 10;
            const kept = action === "set" ? current.records.filter((r) => !(r.name === name && r.type === type)) : current.records;
            records = [...kept, rec];
            summary = `${action === "set" ? "Set" : "Added"} ${type === "URL301" ? "REDIRECT" : type} ${name} -> ${value}`;
        }
        else if (action === "rm" || action === "remove" || action === "delete") {
            if (args.length < 1)
                throw new Error(`Usage: lizard domain dns ${order.domain} rm <name> [type] [value]`);
            const name = relativeName(args[0], order.domain);
            const type = args[1] ? parseType(args[1]) : null;
            const value = args.length > 2 ? args.slice(2).join(" ") : null;
            const match = (r) => r.name === name && (!type || r.type === type) && (value === null || r.value === value);
            const gone = current.records.filter(match);
            if (!gone.length)
                throw new Error(`No record matches ${[name, type, value].filter(Boolean).join(" ")} on ${order.domain}`);
            if (!opts.yes) {
                if (!isTTY())
                    throw new Error("Use -y to confirm in non-interactive mode");
                printRecords(order.domain, gone);
                const ok = await p.confirm({ message: `Remove ${gone.length === 1 ? "this record" : `these ${gone.length} records`} from ${order.domain}?` });
                if (p.isCancel(ok) || !ok)
                    process.exit(5);
            }
            records = current.records.filter((r) => !match(r));
            summary = `Removed ${gone.length} record${gone.length === 1 ? "" : "s"}`;
        }
        else {
            throw new Error(`Unknown action "${action}". Use set, add or rm (or nothing to list).`);
        }
        const saved = await api.put(path, { version: current.version, records }).catch(writeError);
        if (isJSONMode())
            return printJSON({ domain: order.domain, ...saved });
        success(`${summary} on ${order.domain}`);
        printRecords(order.domain, saved.records);
        console.log(chalk.dim("  Changes reach most resolvers within minutes (up to the old record's TTL)."));
    });
}
//# sourceMappingURL=domain-owned.js.map