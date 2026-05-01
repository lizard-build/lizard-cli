import { Command } from "commander";
/**
 * `lizard bucket` — Railway-compat alias for S3 addon management.
 *
 * Currently supports:
 *   lizard bucket create <name> [--region <r>] [--project <p>]
 *
 * Forwards to `lizard add -d s3 --instance-name <name>` so the addon registers
 * as `${{<name>.BUCKET_*}}` in templates.
 */
export declare function registerBucket(program: Command): void;
