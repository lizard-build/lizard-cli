import { Command } from "commander";
/**
 * `lizard run <command...>` — run a local command with platform secrets in
 * the environment. Project-scope secrets are loaded first, then the linked
 * (or `-s <service>`) service overrides on key collisions, mirroring the
 * order the platform applies them on the server.
 *
 * Pass `-s <service>` to switch service without touching the link.
 * Pass `--no-service` to load only project-scope secrets.
 */
export declare function registerRun(program: Command): void;
