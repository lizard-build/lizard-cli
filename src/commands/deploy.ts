import chalk from "chalk";
import { Command } from "commander";
import { info, warn } from "../lib/format.js";

/**
 * `lizard deploy` mirrors `railway deploy` — provisioning a template into the
 * project. This is a stub until the template marketplace lands. Existing users
 * who used `lizard deploy` to upload local code get redirected to `lizard up`.
 */
export function registerDeploy(program: Command) {
  program
    .command("deploy")
    .description("Provision a template into the project (coming soon)")
    .option("-t, --template <code>", "Template code from the marketplace")
    .option(
      "-v, --variable <kv...>",
      "KEY=value pairs (use Service.KEY=value for service-scoped values)",
    )
    .action(async (opts) => {
      if (!opts.template) {
        warn(
          `'lizard deploy' now provisions templates. To upload code use ${chalk.bold("lizard up")}.`,
        );
        info(chalk.dim("\nUsage:"));
        info(chalk.dim("  lizard deploy -t <template-code>"));
        info(chalk.dim("  lizard up                    # upload current dir"));
        info(chalk.dim("  lizard up --service api      # upload to a specific service"));
        process.exit(1);
      }

      info(
        chalk.dim(
          `Template marketplace is coming soon. To create one of the built-in addons use \`lizard add -d ${opts.template}\`.`,
        ),
      );
    });
}
