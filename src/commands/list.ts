import chalk from "chalk";
import { Command } from "commander";
import { api, withQuery } from "../lib/api.js";
import { isJSONMode, printJSON, table } from "../lib/format.js";
import { resolveWorkspace } from "../lib/picker.js";

interface Project {
  id: string;
  name: string;
  slug: string;
  role?: string;
  memberCount?: number;
  workspaceId?: string | null;
  workspaceName?: string | null;
  createdAt?: number;
}

/**
 * `lizard list` — list all projects. Alias of `lizard project list`.
 */
export function registerList(program: Command) {
  program
    .command("list")
    .alias("ls")
    .description("List all projects")
    .option("-w, --workspace <ws>", "Filter by workspace id, slug, or name")
    .action(async (opts) => {
      let workspaceId: string | undefined;
      if (opts.workspace) {
        workspaceId = (await resolveWorkspace(opts.workspace)).id;
      }
      const projects = await api.get<Project[]>(
        withQuery("/api/projects", { workspaceId }),
      );

      if (isJSONMode()) {
        printJSON(projects);
        return;
      }

      if (projects.length === 0) {
        console.log("No projects. Run `lizard init` to create one.");
        return;
      }

      table(
        ["Name", "Workspace", "Slug", "Role", "Members"],
        projects.map((p) => [
          p.name,
          p.workspaceName || chalk.dim("—"),
          p.slug,
          p.role || "owner",
          String(p.memberCount || 1),
        ]),
      );
    });
}
