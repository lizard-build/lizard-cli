import { Command } from "commander";
/**
 * `lizard domain` — Railway-style domain management.
 *   bare         → if no domain, auto-generate one; otherwise show current
 *   <hostname>   → attach a custom domain
 *   delete <h>   → remove a domain
 *   generate     → force-generate a fresh *.onlizard.com subdomain
 */
export declare function registerDomain(program: Command): void;
