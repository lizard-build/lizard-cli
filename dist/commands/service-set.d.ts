import { Command } from "commander";
/**
 * `lizard service set` — atomic patch of per-service configuration.
 *
 * Input modes (priority):
 *   1. <service> --set <path>=<value>    — positional service + repeatable --set pairs
 *   2. -f <file>                         — read JSON from file (multi-service)
 *   3. piped stdin JSON                  — auto-detected when stdin has data
 *   4. interactive                       — TTY prompts when nothing else is given
 *
 * Field names are flat and match the wire schema of `POST /config:apply`
 * exactly. There is no nested {build,deploy,source} grouping anywhere in the
 * system — DB columns, REST schemas, node-agent payloads, and `service show`
 * output are all flat. See SERVICE_FIELDS below for the full list.
 *
 * Namespaces (variables.*, secrets.*, sharedVariables) are kept because they
 * really are separate stores (per-service / project-wide env), not flat
 * service-config fields.
 */
/**
 * Canonical service-config fields accepted by `--set` and as keys in a `-f`
 * file's cfg blob. Mirrors `configApplySchema.serviceConfigSchema` in
 * dragonlabs-platform/server/src/routes/projects.ts.
 */
export declare const SERVICE_FIELDS: readonly ["name", "sourceType", "repoUrl", "branch", "rootDirectory", "buildCommand", "watchPatterns", "dockerfilePath", "startCommand", "preDeployCommand", "healthcheckPath", "healthcheckTimeoutMs"];
export declare function validateName(name: string): string | null;
export declare function registerServiceSet(svc: Command): void;
/**
 * Convert a normalised patch (services keyed by id, flat cfg blobs) into the
 * wire body for `POST /api/projects/:id/config:apply`:
 *
 *   { services: [{ id, name?, buildCommand?, startCommand?, ... }],
 *     secrets?: { shared?, services? } }
 *
 * `nameById` provides the current display name for each service id. Rename
 * fires only when cfg.name is set AND differs from current — equal names
 * are silently dropped so non-rename calls don't bloat the audit log.
 *
 * Unknown fields in cfg throw before any network call.
 */
export declare function flattenPatch(patch: any, nameById: Map<string, string>): {
    services: any[];
    secrets?: any;
};
/**
 * Reject a wire body that combines a rename with per-service secret updates.
 * The backend's `secrets.services[<name>]` lookup uses a pre-rename snapshot
 * of the apps table, so a rename + secrets-by-new-name in one call fails
 * with "Unknown services in secrets". Catch it client-side with a clearer
 * message before sending.
 */
export declare function validateNoRenameWithSecrets(body: {
    services: any[];
    secrets?: any;
}, nameById: Map<string, string>): void;
/** Validate a `--set` dot-path against the canonical (flat) field list and
 *  the `variables.*` namespace. Throws on anything else. */
export declare function validateSetPath(dotPath: string): void;
export declare function parseValue(dotPath: string, raw: string): unknown;
export declare function setDeep(obj: Record<string, any>, dotPath: string, value: unknown): void;
