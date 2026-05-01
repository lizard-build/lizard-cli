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
export function registerBucket(program: Command) {
  const bucket = program
    .command("bucket")
    .description("Manage S3 buckets (Railway-compat alias for `add -d s3`)");

  bucket
    .command("create <name>")
    .description("Create an S3 bucket addon with the given instance name")
    .option("--region <region>", "Region for the bucket")
    .option("-p, --project <name>", "Project name or ID")
    .action(async (name: string, opts) => {
      const args = ["add", "-d", "s3", "--instance-name", name];
      if (opts.region) args.push("--region", opts.region);
      if (opts.project) args.push("-p", opts.project);
      await program.parseAsync(args, { from: "user" });
    });
}
