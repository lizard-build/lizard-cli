import chalk from "chalk";
import path from "node:path";
import * as p from "@clack/prompts";
import { Command } from "commander";
import { api, withQuery, type Workspace } from "../lib/api.js";
import {
  getProjectLink,
  setProjectLink,
  type ProjectLink,
} from "../lib/config.js";
import {
  success,
  info,
  isJSONMode,
  printJSON,
  isTTY,
} from "../lib/format.js";
import { fetchWorkspaces, pickWorkspace } from "../lib/picker.js";

interface Project {
  id: string;
  name: string;
  slug: string;
  workspaceId?: string | null;
}

/**
 * Ensure the current directory is linked to a project. If already linked and
 * `force` is false, returns the existing link. Otherwise runs the
 * create-or-select flow.
 *
 * Flow (mirrors Railway's `link` wizard):
 *   1. Workspace — selected by --workspace, single workspace auto-pick,
 *      or interactive select. Skipped when only one workspace exists.
 *   2. Project — matched by --name within the workspace, picked from the
 *      workspace's project list, or created.
 *
 * `projectName` (from --name / --project) is matched against existing
 * projects inside the resolved workspace; if not found, a new project
 * with that name is created in the resolved workspace.
 */
export async function ensureLinked(opts: {
  projectName?: string;
  workspaceFlag?: string;
  force?: boolean;
  relinkPrompt?: boolean;
} = {}): Promise<ProjectLink> {
  const existing = getProjectLink();

  if (existing && !opts.force) {
    if (!opts.relinkPrompt) return existing;

    if (!isTTY()) {
      throw new Error(
        `Already linked to ${existing.projectName || existing.projectId}. Use --force to relink.`,
      );
    }
    const proceed = await p.confirm({
      message: `Directory is linked to "${existing.projectName || existing.projectId}". Relink?`,
      initialValue: false,
    });
    if (p.isCancel(proceed) || !proceed) return existing;
  }

  // 1. Workspace
  const workspaces = await fetchWorkspaces();
  const workspace = await pickWorkspace({
    flag: opts.workspaceFlag,
    projectNameHint: opts.projectName,
    workspaces,
  });

  // 2. Project — pulled from the chosen workspace only
  const projects = await api.get<Project[]>(
    withQuery("/api/projects", { workspaceId: workspace.id }),
  );

  let project: Project;

  if (opts.projectName) {
    const lower = opts.projectName.toLowerCase();
    const match = projects.find(
      (pr) =>
        pr.name.toLowerCase() === lower ||
        pr.slug.toLowerCase() === lower ||
        pr.id.toLowerCase() === lower,
    );
    project =
      match ??
      (await api.post<Project>("/api/projects", {
        name: opts.projectName,
        workspaceId: workspace.id,
      }));
  } else if (!isTTY()) {
    project = await api.post<Project>("/api/projects", {
      name: path.basename(process.cwd()),
      workspaceId: workspace.id,
    });
  } else {
    let action: "create" | "select" = "create";
    if (projects.length > 0) {
      const choice = await p.select({
        message: `Link a project in ${workspace.name}`,
        options: [
          { value: "create", label: "Create new project" },
          { value: "select", label: "Select existing project" },
        ],
      });
      if (p.isCancel(choice)) process.exit(5);
      action = choice as "create" | "select";
    }

    if (action === "create") {
      const nameRes = await p.text({
        message: "Project name",
        defaultValue: path.basename(process.cwd()),
        placeholder: path.basename(process.cwd()),
      });
      if (p.isCancel(nameRes)) process.exit(5);
      project = await api.post<Project>("/api/projects", {
        name: nameRes as string,
        workspaceId: workspace.id,
      });
    } else {
      const selected = await p.select({
        message: "Select project",
        options: projects.map((pr) => ({
          value: pr.id,
          label: pr.name,
          hint: pr.id,
        })),
      });
      if (p.isCancel(selected)) process.exit(5);
      project = projects.find((pr) => pr.id === selected)!;
    }
  }

  const link: ProjectLink = {
    projectId: project.id,
    projectName: project.name,
    workspaceId: workspace.id,
    workspaceName: workspace.name,
  };
  setProjectLink(link);
  return link;
}

export function registerInit(program: Command) {
  program
    .command("init")
    .description(
      "Create or select a project and link it to the current directory",
    )
    .option("-n, --name <name>", "Project name (use existing or create if missing)")
    .option("--project <name>", "Alias for --name (kept for backwards compat)")
    .option("-w, --workspace <ws>", "Workspace id, slug, or name")
    .option("--force", "Relink even if this directory is already linked")
    .action(async (opts) => {
      const projectName = opts.name || opts.project;
      const link = await ensureLinked({
        projectName,
        workspaceFlag: opts.workspace,
        force: opts.force,
        relinkPrompt: true,
      });

      if (isJSONMode()) {
        printJSON({
          projectId: link.projectId,
          name: link.projectName,
          workspaceId: link.workspaceId,
          workspaceName: link.workspaceName,
        });
      } else {
        const wsLabel = link.workspaceName
          ? chalk.dim(` (${link.workspaceName})`)
          : "";
        success(
          `Linked to ${chalk.bold(link.projectName || link.projectId)}${wsLabel}`,
        );
        info(chalk.dim("  Saved to ~/.lizard/config.json"));
      }
    });
}

// Re-export Workspace so consumers can import the type from this module if
// they ever want to (kept for older imports, harmless if unused).
export type { Workspace };
