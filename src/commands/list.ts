import chalk from "chalk";
import { Command } from "commander";
import { api } from "../lib/api.js";
import { isJSONMode, printJSON, table } from "../lib/format.js";

interface Project {
  id: string;
  name: string;
  slug: string;
  role?: string;
  memberCount?: number;
  createdAt?: number;
}

/**
 * `lizard list` — Railway-style project list. Equivalent to the legacy
 * `lizard project list`.
 */
export function registerList(program: Command) {
  program
    .command("list")
    .alias("ls")
    .description("List all projects")
    .action(async () => {
      const projects = await api.get<Project[]>("/api/projects");

      if (isJSONMode()) {
        printJSON(projects);
        return;
      }

      if (projects.length === 0) {
        console.log("No projects. Run `lizard init` to create one.");
        return;
      }

      table(
        ["Name", "ID", "Role", "Members"],
        projects.map((p) => [
          p.name,
          p.id,
          p.role || "owner",
          String(p.memberCount || 1),
        ]),
      );
    });
}
