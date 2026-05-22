import chalk from "chalk";
import * as p from "@clack/prompts";
import { api, withQuery, withScope } from "../lib/api.js";
import { setProjectLink } from "../lib/config.js";
import { isJSONMode, printJSON, isTTY, success } from "../lib/format.js";
import { fetchWorkspaces, pickWorkspace } from "../lib/picker.js";
/**
 * `lizard link` — associates the current directory with an existing
 * project + environment + (optional) service. Each piece can be passed
 * via flags or selected interactively.
 *
 * Order matches Railway's wizard: workspace → project → environment → service.
 */
export function registerLink(program) {
    program
        .command("link")
        .description("Associate the current directory with an existing project")
        .argument("[service]", "Service name or ID (optional)")
        .option("-p, --project <id>", "Project name or ID")
        .option("-w, --workspace <ws>", "Workspace id, slug, or name")
        .option("-s, --service <name>", "Service name or ID (optional)")
        .action(async (serviceArg, opts) => {
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
        const projects = await api.get(withQuery("/api/projects", { workspaceId: workspace.id }));
        if (projects.length === 0) {
            throw new Error(`No projects in ${workspace.name}. Run \`lizard init\` to create one.`);
        }
        let project;
        if (projectFlag) {
            const lower = projectFlag.toLowerCase();
            const match = projects.find((pr) => pr.id.toLowerCase() === lower ||
                pr.slug?.toLowerCase() === lower ||
                pr.name.toLowerCase() === lower);
            if (!match) {
                throw new Error(`Project "${projectFlag}" not found in ${workspace.name}. Available: ${projects.map((pr) => pr.name).join(", ")}`);
            }
            project = match;
        }
        else if (projects.length === 1) {
            project = projects[0];
        }
        else {
            if (!isTTY())
                throw new Error("--project required in non-interactive mode");
            const sel = await p.select({
                message: `Select a project in ${workspace.name}`,
                options: projects.map((pr) => ({ value: pr.id, label: pr.name, hint: pr.id })),
            });
            if (p.isCancel(sel))
                process.exit(5);
            project = projects.find((pr) => pr.id === sel);
        }
        // 3. Environment (optional — silently skip if API has no envs)
        let environment = null;
        try {
            const envs = await api.get(withScope(`/api/projects/${project.id}/environments`, {
                workspaceId: workspace.id,
                environmentName: null,
            }));
            if (envs?.length) {
                if (envs.length === 1) {
                    environment = envs[0];
                }
                else if (isTTY()) {
                    const sel = await p.select({
                        message: "Select an environment",
                        options: envs.map((e) => ({ value: e.id, label: e.name })),
                    });
                    if (p.isCancel(sel))
                        process.exit(5);
                    environment = envs.find((e) => e.id === sel);
                }
                else {
                    environment = envs[0];
                }
            }
        }
        catch {
            // API does not have environments yet — fine
        }
        // 4. Service (optional)
        const services = await api
            .get(withQuery(`/api/projects/${project.id}/services`, {
            workspaceId: workspace.id,
            environment: environment?.name,
        }))
            .catch(() => ({ apps: [], addons: [] }));
        const allServices = [
            ...(services.apps || []),
            ...(services.addons || []),
        ];
        let service = null;
        if (serviceFlag) {
            const lower = serviceFlag.toLowerCase();
            service =
                allServices.find((s) => s.id.toLowerCase() === lower || s.name?.toLowerCase() === lower) || null;
            if (!service) {
                throw new Error(`Service "${serviceFlag}" not found. Available: ${allServices.map((s) => s.name).join(", ")}`);
            }
        }
        else if (allServices.length > 0 && isTTY()) {
            const choices = [
                { value: "", label: "(none — link only project)" },
                ...allServices.map((s) => ({ value: s.id, label: s.name, hint: s.status })),
            ];
            const sel = await p.select({
                message: "Select a service (optional)",
                options: choices,
            });
            if (p.isCancel(sel))
                process.exit(5);
            if (sel)
                service = allServices.find((s) => s.id === sel);
        }
        // Save
        const link = {
            projectId: project.id,
            projectName: project.name,
            workspaceId: workspace.id,
            workspaceName: workspace.name,
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
                workspaceId: link.workspaceId,
                workspaceName: link.workspaceName,
                environmentId: link.environmentId,
                environmentName: link.environmentName,
                serviceId: link.serviceId,
                serviceName: link.serviceName,
            });
        }
        else {
            const wsLabel = link.workspaceName ? chalk.dim(` (${link.workspaceName})`) : "";
            success(`Linked to ${chalk.bold(project.name)}${service ? ` / ${chalk.bold(service.name)}` : ""}${wsLabel}`);
        }
    });
}
//# sourceMappingURL=link.js.map