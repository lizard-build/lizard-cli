import { Command } from "commander";
/**
 * `lizard service` — Railway-style group:
 *   - bare: link a service to cwd (legacy: `railway service <name>`)
 *   - list / link / status / delete / redeploy / restart / scale / logs
 */
export declare function registerService(program: Command): void;
