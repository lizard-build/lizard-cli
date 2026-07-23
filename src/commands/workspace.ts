import chalk from "chalk";
import { Command } from "commander";
import { api, type Workspace } from "../lib/api.js";
import { fetchWorkspaces } from "../lib/picker.js";
import { isJSONMode, printJSON, table, success, info } from "../lib/format.js";

/**
 * `lizard workspace` — create and list workspaces.
 *
 * Member management (invite/remove/rename) intentionally lives in the
 * dashboard, not here, to keep CLI surface narrow (Railway model).
 */
export function registerWorkspace(program: Command) {
  const ws = program
    .command("workspace")
    .description("Create and list workspaces");

  ws.command("create")
    .argument("<name>", "Workspace name")
    .description("Create a new workspace")
    .action(async (name: string) => {
      const workspace = await api.post<Workspace>("/api/workspaces", { name });

      if (isJSONMode()) {
        printJSON(workspace);
        return;
      }

      success(`Workspace ${chalk.bold(workspace.name)} created`);
      info(chalk.dim(`  Slug: ${workspace.slug}`));
      info(chalk.dim(`  Add a project: lizard project create <name> --workspace ${workspace.slug}`));
    });

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
