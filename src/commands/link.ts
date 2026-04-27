import chalk from "chalk";
import * as p from "@clack/prompts";
import { Command } from "commander";
import { api } from "../lib/api.js";
import { setProjectLink, type ProjectLink } from "../lib/config.js";
import { isJSONMode, printJSON, isTTY, success } from "../lib/format.js";

interface Project {
  id: string;
  name: string;
  slug: string;
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

interface EnvironmentInfo {
  id: string;
  name: string;
}

/**
 * `lizard link` — Railway-style. Associates the current directory with an
 * existing project + environment + (optional) service. Each piece can be
 * passed via flags or selected interactively.
 */
export function registerLink(program: Command) {
  program
    .command("link")
    .description("Associate the current directory with an existing project")
    .option("-p, --project <id>", "Project name or ID")
    .option("-e, --environment <name>", "Environment name or ID")
    .option("-s, --service <name>", "Service name or ID (optional)")
    .action(async (opts) => {
      const projectFlag = opts.project;
      const envFlag = opts.environment;
      const serviceFlag = opts.service;

      // 1. Project
      const projects = await api.get<Project[]>("/api/projects");
      if (projects.length === 0) {
        throw new Error("No projects available. Run `lizard init` to create one.");
      }
      let project: Project;
      if (projectFlag) {
        const lower = projectFlag.toLowerCase();
        const match = projects.find(
          (p) =>
            p.id.toLowerCase() === lower ||
            p.slug?.toLowerCase() === lower ||
            p.name.toLowerCase() === lower,
        );
        if (!match) throw new Error(`Project "${projectFlag}" not found`);
        project = match;
      } else if (projects.length === 1) {
        project = projects[0];
      } else {
        if (!isTTY()) throw new Error("--project required in non-interactive mode");
        const sel = await p.select({
          message: "Select a project",
          options: projects.map((p) => ({ value: p.id, label: p.name, hint: p.id })),
        });
        if (p.isCancel(sel)) process.exit(5);
        project = projects.find((pr) => pr.id === sel)!;
      }

      // 2. Environment (optional — silently skip if API has no envs)
      let environment: EnvironmentInfo | null = null;
      try {
        const envs = await api.get<EnvironmentInfo[]>(
          `/api/projects/${project.id}/environments`,
        );
        if (envs?.length) {
          if (envFlag) {
            const lower = envFlag.toLowerCase();
            const m = envs.find(
              (e) => e.id.toLowerCase() === lower || e.name.toLowerCase() === lower,
            );
            if (!m) throw new Error(`Environment "${envFlag}" not found`);
            environment = m;
          } else if (envs.length === 1) {
            environment = envs[0];
          } else if (isTTY()) {
            const sel = await p.select({
              message: "Select an environment",
              options: envs.map((e) => ({ value: e.id, label: e.name })),
            });
            if (p.isCancel(sel)) process.exit(5);
            environment = envs.find((e) => e.id === sel)!;
          } else {
            environment = envs[0];
          }
        }
      } catch {
        // API does not have environments yet — fine
      }

      // 3. Service (optional)
      const services = await api
        .get<ServicesResponse>(`/api/projects/${project.id}/services`)
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
        environmentId: environment?.id,
        environmentName: environment?.name,
        serviceId: service?.id,
        serviceName: service?.name,
      };
      setProjectLink(link);

      if (isJSONMode()) {
        printJSON({
          projectId: link.projectId,
          projectName: link.projectName,
          environmentId: link.environmentId,
          environmentName: link.environmentName,
          serviceId: link.serviceId,
          serviceName: link.serviceName,
        });
      } else {
        success(`Linked to ${chalk.bold(project.name)}${service ? ` / ${chalk.bold(service.name)}` : ""}`);
      }
    });
}
