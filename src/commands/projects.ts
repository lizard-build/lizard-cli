import chalk from "chalk";
import { Command } from "commander";
import { api } from "../lib/api.js";
import {
  findProjectConfig,
  loadGlobalSettings,
  saveGlobalSettings,
} from "../lib/config.js";
import {
  success,
  isJSONMode,
  printJSON,
  table,
} from "../lib/format.js";

interface Project {
  id: string;
  name: string;
  slug: string;
  role: string;
  memberCount: number;
  createdAt: number;
}

function findProject(projects: Project[], nameOrId: string): Project | undefined {
  return (
    projects.find((p) => p.id === nameOrId) ||
    projects.find((p) => p.slug === nameOrId) ||
    projects.find((p) => p.name === nameOrId)
  );
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
    .command("use")
    .argument("<name_or_id>", "Project name, slug or ID")
    .description("Set default project used when cwd has no .lizard/config.json")
    .action(async (nameOrId: string) => {
      const projects = await api.get<Project[]>("/api/projects");
      const match = findProject(projects, nameOrId);
      if (!match) {
        throw new Error(
          `Project "${nameOrId}" not found. Available: ${projects.map((p) => p.name).join(", ")}`,
        );
      }

      const settings = loadGlobalSettings();
      saveGlobalSettings({
        ...settings,
        defaultProject: match.id,
        defaultProjectName: match.name,
      });

      if (isJSONMode()) {
        printJSON({ defaultProject: match.id, name: match.name });
      } else {
        success(`Default project set to ${chalk.bold(match.name)}`);
      }
    });

  proj
    .command("current")
    .description("Show which project will be used in the current directory")
    .action(() => {
      const local = findProjectConfig();
      const global = loadGlobalSettings();

      const resolved = local?.projectId
        ? {
            source: "link",
            projectId: local.projectId,
            name: local.projectName,
          }
        : global.defaultProject
          ? {
              source: "default",
              projectId: global.defaultProject,
              name: global.defaultProjectName,
            }
          : null;

      if (isJSONMode()) {
        printJSON(resolved);
        return;
      }

      if (!resolved) {
        console.log(
          "No project for this directory. Run `lizard link` or `lizard project use <name>`.",
        );
        return;
      }

      const label = resolved.name || resolved.projectId;
      if (resolved.source === "link") {
        console.log(
          `${chalk.bold(label)} ${chalk.dim(`(${resolved.projectId})`)}`,
        );
        console.log(chalk.dim("  source: .lizard/config.json in this directory"));
      } else {
        console.log(
          `${chalk.bold(label)} ${chalk.dim(`(${resolved.projectId})`)}`,
        );
        console.log(chalk.dim("  source: default from ~/.lizard/settings.json"));
      }
    });

  proj
    .command("unuse")
    .description("Clear the global default project")
    .action(() => {
      const settings = loadGlobalSettings();
      if (!settings.defaultProject) {
        if (isJSONMode()) {
          printJSON({ cleared: false });
        } else {
          console.log("No default project was set.");
        }
        return;
      }
      delete settings.defaultProject;
      delete settings.defaultProjectName;
      saveGlobalSettings(settings);

      if (isJSONMode()) {
        printJSON({ cleared: true });
      } else {
        success("Default project cleared");
      }
    });
}
