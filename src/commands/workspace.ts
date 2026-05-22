import chalk from "chalk";
import { Command } from "commander";
import { fetchWorkspaces } from "../lib/picker.js";
import { isJSONMode, printJSON, table } from "../lib/format.js";

/**
 * `lizard workspace` — workspace info.
 *
 * Member management (invite/remove/rename) intentionally lives in the
 * dashboard, not here, to keep CLI surface narrow (Railway model).
 */
export function registerWorkspace(program: Command) {
  const ws = program
    .command("workspace")
    .description("Workspace info");

  ws.command("list")
    .alias("ls")
    .description("List workspaces you belong to")
    .action(async () => {
      const list = await fetchWorkspaces();

      if (isJSONMode()) {
        printJSON(list);
        return;
      }

      if (list.length === 0) {
        console.log("No workspaces. The backend should always return a personal workspace.");
        return;
      }

      table(
        ["Name", "Slug", "Role", "Projects", "Personal"],
        list.map((w) => [
          w.name,
          w.slug,
          w.role,
          String(w.projectCount ?? 0),
          w.isPersonal ? chalk.green("✓") : "",
        ]),
      );
    });
}
