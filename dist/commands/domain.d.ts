import { Command } from "commander";
/**
 * `lizard domain` — domain management.
 *   bare         → if no domain, auto-generate one; otherwise show current
 *   <hostname>   → attach a custom domain
 *   delete <h>   → remove a domain
 *   generate     → force-generate a fresh *.onlizard.com subdomain
 *   owned        → domains bought on Lizard; dns <domain> → their DNS records
 *
 * A hostname on a domain bought on Lizard (or a subdomain of one) is pointed and attached
 * in one step: the platform writes the DNS record itself, no records to copy.
 */
export declare function registerDomain(program: Command): void;
