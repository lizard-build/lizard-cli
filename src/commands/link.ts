import chalk from "chalk";
import * as p from "@clack/prompts";
import { Command } from "commander";
import { api, withQuery } from "../lib/api.js";
import { setProjectLink, type ProjectLink } from "../lib/config.js";
import { isJSONMode, printJSON, isTTY, success } from "../lib/format.js";
import { fetchWorkspaces, pickWorkspace } from "../lib/picker.js";

interface Project {
  id: string;
  name: string;
  slug: string;
  workspaceId?: string | null;
}

interface ServiceInfo {
  id: string;
  name: string;
  status?: string;
}

interface ServicesResponse {
  apps?: ServiceInfo[];
  addons?: ServiceInfo[];
}

/**
 * `lizard link` — associates the current directory with an existing
 * project and (optionally) service. Each piece can be passed via flags
 * or selected interactively.
 *
 * Order matches Railway's wizard: workspace → project → service.
 */
export function registerLink(program: Command) {
  program
    .command("link")
    .description("Associate the current directory with an existing project")
    .argument("[service]", "Service name or ID (optional)")
    .option("-p, --project <id>", "Project name, slug, or ID")
    .option("-w, --workspace <ws>", "Workspace id, slug, or name")
    .option("-s, --service <name>", "Service name or ID (optional)")
    .action(async (serviceArg: string | undefined, opts) => {
      const projectFlag = opts.project;
      const serviceFlag = serviceArg || opts.service;

      // 1. Workspace
      const workspaces = await fetchWorkspaces();
      const workspace = await pickWorkspace({
        flag: opts.workspace,
        projectNameHint: projectFlag,
        workspaces,
      });

      // 2. Project (within workspace)
      const projects = await api.get<Project[]>(
        withQuery("/api/projects", { workspaceId: workspace.id }),
      );
      if (projects.length === 0) {
        throw new Error(
          `No projects in ${workspace.name}. Run \`lizard init\` to create one.`,
        );
      }
      let project: Project;
      if (projectFlag) {
        const lower = projectFlag.toLowerCase();
        const match = projects.find(
          (pr) =>
            pr.id.toLowerCase() === lower ||
            pr.slug?.toLowerCase() === lower ||
            pr.name.toLowerCase() === lower,
        );
        if (!match) {
          throw new Error(
            `Project "${projectFlag}" not found in ${workspace.name}. Available: ${projects.map((pr) => pr.name).join(", ")}`,
          );
        }
        project = match;
      } else if (projects.length === 1) {
        project = projects[0];
      } else {
        if (!isTTY()) throw new Error("--project required in non-interactive mode");
        const sel = await p.select({
          message: `Select a project in ${workspace.name}`,
          options: projects.map((pr) => ({ value: pr.id, label: pr.name, hint: pr.id })),
        });
        if (p.isCancel(sel)) process.exit(5);
        project = projects.find((pr) => pr.id === sel)!;
      }

      // 3. Service (optional)
      const services = await api
        .get<ServicesResponse>(
          withQuery(`/api/projects/${project.id}/services`, {
            workspaceId: workspace.id,
          }),
        )
        .catch(() => ({ apps: [], addons: [] }) as ServicesResponse);
      const allServices = [
        ...(services.apps || []),
        ...(services.addons || []),
      ];

      let service: ServiceInfo | null = null;
      if (serviceFlag) {
        const lower = serviceFlag.toLowerCase();
        service =
          allServices.find(
            (s) => s.id.toLowerCase() === lower || s.name?.toLowerCase() === lower,
          ) || null;
        if (!service) {
          throw new Error(
            `Service "${serviceFlag}" not found. Available: ${allServices.map((s) => s.name).join(", ")}`,
          );
        }
      } else if (allServices.length > 0 && isTTY()) {
        const choices = [
          { value: "", label: "(none — link only project)" },
          ...allServices.map((s) => ({ value: s.id, label: s.name, hint: s.status })),
        ];
        const sel = await p.select({
          message: "Select a service (optional)",
          options: choices,
        });
        if (p.isCancel(sel)) process.exit(5);
        if (sel) service = allServices.find((s) => s.id === sel)!;
      }

      // Save
      const link: ProjectLink = {
        projectId: project.id,
        projectName: project.name,
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        serviceId: service?.id,
        serviceName: service?.name,
      };
      setProjectLink(link);

      if (isJSONMode()) {
        printJSON({
          projectId: link.projectId,
          projectName: link.projectName,
          workspaceId: link.workspaceId,
          workspaceName: link.workspaceName,
          serviceId: link.serviceId,
          serviceName: link.serviceName,
        });
      } else {
        const wsLabel = link.workspaceName ? chalk.dim(` (${link.workspaceName})`) : "";
        success(
          `Linked to ${chalk.bold(project.name)}${service ? ` / ${chalk.bold(service.name)}` : ""}${wsLabel}`,
        );
      }
    });
}
