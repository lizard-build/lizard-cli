import chalk from "chalk";
import { api } from "../lib/api.js";
import { resolveProjectId } from "../lib/config.js";
import { isJSONMode, printJSON, statusColor, table } from "../lib/format.js";
export function registerContext(program) {
    program
        .command("context")
        .description("Show full project context (optimized for AI agents)")
        .action(async () => {
        const projectId = resolveProjectId(program.opts().project);
        const [project, services, secrets] = await Promise.all([
            api.get(`/api/projects/${projectId}`),
            api.get(`/api/projects/${projectId}/services`),
            api.get(`/api/projects/${projectId}/secrets`).catch(() => []),
        ]);
        const context = {
            project: {
                id: project.id,
                name: project.name,
                slug: project.slug,
            },
            apps: (services.apps || []).map((a) => ({
                id: a.id,
                name: a.name,
                status: a.status,
                domain: a.domain,
                repo: a.repo,
                branch: a.branch,
                cpuLimit: a.cpuLimit,
                memoryLimit: a.memoryLimit,
            })),
            addons: (services.addons || []).map((a) => ({
                id: a.id,
                name: a.name,
                type: a.addonType,
                status: a.status,
                hostname: a.hostname,
            })),
            secrets: secrets.map((s) => s.key),
        };
        if (isJSONMode() || !process.stdout.isTTY) {
            printJSON(context);
            return;
        }
        console.log(chalk.bold(context.project.name) + chalk.dim(` (${context.project.id})`));
        console.log();
        if (context.apps.length > 0) {
            console.log(chalk.bold("Apps:"));
            table(["Name", "Status", "Domain"], context.apps.map((a) => [
                a.name,
                statusColor(a.status),
                a.domain ? `https://${a.domain}` : "—",
            ]));
            console.log();
        }
        if (context.addons.length > 0) {
            console.log(chalk.bold("Addons:"));
            table(["Name", "Type", "Status", "Host"], context.addons.map((a) => [a.name, a.type, statusColor(a.status), a.hostname || "—"]));
            console.log();
        }
        if (context.secrets.length > 0) {
            console.log(chalk.bold("Secrets:") + " " + context.secrets.join(", "));
        }
    });
}
//# sourceMappingURL=context.js.map