import { Command } from "commander";
/**
 * `lizard domain` — Railway-style domain management.
 *   bare         → list domains for linked/--service
 *   <hostname>   → add a custom domain
 *   delete <h>   → remove a domain
 *   generate     → create a *.lizard.app subdomain
 */
export declare function registerDomain(program: Command): void;
