import chalk from "chalk";
import * as p from "@clack/prompts";
import { Command } from "commander";
import { api, withQuery } from "../lib/api.js";
import { success, isJSONMode, printJSON, table, isTTY } from "../lib/format.js";
import { pickWorkspace, resolveWorkspace } from "../lib/picker.js";
import { resolveProjectId } from "../lib/config.js";

interface Project {
  id: string;
  name: string;
  slug: string;
  role: string;
  memberCount: number;
  workspaceId?: string | null;
  workspaceName?: string | null;
  createdAt: number;
}

export function registerProjects(program: Command) {
  const proj = program
    .command("project")
    .description("Project management");

  proj
    .command("list")
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

  proj
    .command("create")
    .argument("<name>", "Project name")
    .description("Create a new project without linking it to this directory")
    .option("-w, --workspace <ws>", "Workspace to create the project in")
    .action(async (name: string, opts) => {
      const workspace = await pickWorkspace({ flag: opts.workspace });
      const project = await api.post<Project>("/api/projects", {
        name,
        workspaceId: workspace.id,
      });

      if (isJSONMode()) {
        printJSON({
          ...project,
          workspaceId: project.workspaceId ?? workspace.id,
          workspaceName: project.workspaceName ?? workspace.name,
        });
      } else {
        success(
          `Project ${chalk.bold(project.name)} created in ${chalk.bold(workspace.name)}`,
        );
      }
    });

  proj
    .command("delete")
    .alias("rm")
    .description("Delete a project — moves it to trash, permanently purged after 3 days")
    .argument("[project]", "Project name, slug, or ID (defaults to the project linked in this directory)")
    .option("-y, --yes", "Skip confirmation")
    .action(async (projectArg: string | undefined, opts) => {
      const projectId = await resolveProjectId(projectArg);
      const projects = await api.get<Project[]>("/api/projects");
      const name = projects.find((proj) => proj.id === projectId)?.name ?? projectId;

      if (!opts.yes) {
        if (!isTTY()) throw new Error("Use -y to confirm in non-interactive mode");
        const confirm = await p.confirm({
          message: `Delete project ${chalk.bold(name)}? All its services will stop; the project is recoverable for 3 days, then permanently removed.`,
        });
        if (p.isCancel(confirm) || !confirm) process.exit(5);
      }

      await api.delete(`/api/projects/${projectId}`);

      if (isJSONMode()) {
        printJSON({ id: projectId, name, status: "deleted" });
      } else {
        success(`Project ${chalk.bold(name)} deleted (recoverable for 3 days)`);
      }
    });
}
