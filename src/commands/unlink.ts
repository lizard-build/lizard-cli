import { Command } from "commander";
import { clearProjectLink } from "../lib/config.js";
import { isJSONMode, printJSON, success } from "../lib/format.js";

/**
 * `lizard unlink` — Railway-style. Drops the cwd↔project mapping.
 */
export function registerUnlink(program: Command) {
  program
    .command("unlink")
    .description("Disassociate the current directory from any project")
    .action(() => {
      clearProjectLink();
      if (isJSONMode()) printJSON({ status: "unlinked" });
      else success("Directory unlinked");
    });
}
