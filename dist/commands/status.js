import chalk from "chalk";
import { getProjectLink, updateProjectLink } from "../lib/config.js";
import { lookupProjectWorkspace } from "../lib/resolve.js";
import { isJSONMode, printJSON, info } from "../lib/format.js";
/**
 * `lizard status` — print the linked workspace / project / service for
 * the current working directory. Mirrors `railway status`.
 *
 * Lazy-fills workspaceId into the link when missing so legacy configs
 * surface their workspace too.
 */
export function registerStatus(program) {
    program
        .command("status")
        .description("Show linked workspace, project, and service")
        .action(async () => {
        const link = getProjectLink();
        if (!link) {
            if (isJSONMode()) {
                printJSON({ cwd: process.cwd(), linked: false });
            }
            else {
                info("Not linked. Run `lizard init` to create or link a project.");
            }
            return;
        }
        // Backfill workspace info for legacy links (saved before workspaces existed)
        let workspaceName = link.workspaceName;
        if (!link.workspaceId) {
            const fetched = await lookupProjectWorkspace(link.projectId);
            if (fetched?.workspaceId) {
                workspaceName = fetched.workspaceName ?? undefined;
                try {
                    updateProjectLink({
                        workspaceId: fetched.workspaceId,
                        workspaceName,
                    });
                }
                catch { }
            }
        }
        const out = {
            cwd: process.cwd(),
            linked: true,
            workspace: workspaceName ?? null,
            workspaceId: link.workspaceId ?? null,
            project: link.projectName ?? null,
            projectId: link.projectId,
            service: link.serviceName ?? null,
            serviceId: link.serviceId ?? null,
        };
        if (isJSONMode()) {
            printJSON(out);
            return;
        }
        const fmt = (v) => v ?? chalk.dim("—");
        console.log(`  ${chalk.dim("Workspace:")}  ${fmt(out.workspace)}`);
        console.log(`  ${chalk.dim("Project:")}    ${chalk.bold(out.project ?? link.projectId)}`);
        console.log(`  ${chalk.dim("Service:")}    ${out.service ? chalk.bold(out.service) : chalk.dim("(none — `lizard service link`)")}`);
    });
}
//# sourceMappingURL=status.js.map