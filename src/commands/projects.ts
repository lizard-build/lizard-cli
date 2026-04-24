import chalk from "chalk";
import { Command } from "commander";
import { api } from "../lib/api.js";
import { success, isJSONMode, printJSON, table } from "../lib/format.js";

interface Project {
  id: string;
  name: string;
  slug: string;
  role: string;
  memberCount: number;
  createdAt: number;
}

export function registerProjects(program: Command) {
  const proj = program
    .command("project")
    .description("Project management");

  proj
    .command("list")
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

  proj
    .command("create")
    .argument("<name>", "Project name")
    .description("Create a new project without linking it to this directory")
    .action(async (name: string) => {
      const project = await api.post<Project>("/api/projects", { name });

      if (isJSONMode()) {
        printJSON(project);
      } else {
        success(`Project ${chalk.bold(project.name)} created`);
      }
    });
}
