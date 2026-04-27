import { api } from "../lib/api.js";
import { resolveProjectId } from "../lib/config.js";
import { success, isJSONMode, printJSON, table, info } from "../lib/format.js";
export function registerEnv(program) {
    const env = program
        .command("env")
        .description("Manage environments within a project");
    env
        .command("list")
        .description("List environments in the project")
        .action(async () => {
        const projectId = resolveProjectId(program.opts().project);
        const envs = await api.get(`/api/projects/${projectId}/environments`);
        if (isJSONMode()) {
            printJSON(envs);
            return;
        }
        if (envs.length === 0) {
            info(`No environments. Use \`lizard env create <name>\` to add one.`);
            return;
        }
        table(["ID", "Name"], envs.map((e) => [e.id, e.name]));
    });
    env
        .command("create")
        .argument("<name>", "Environment name")
        .description("Create a new environment")
        .option("--from <envId>", "Copy env vars from an existing environment")
        .action(async (name, opts) => {
        const projectId = resolveProjectId(program.opts().project);
        const body = { name };
        if (opts.from)
            body.sourceEnvironmentId = opts.from;
        const created = await api.post(`/api/projects/${projectId}/environments`, body);
        if (isJSONMode()) {
            printJSON(created);
            return;
        }
        success(`Environment "${created.name}" created (${created.id})`);
    });
    env
        .command("delete")
        .argument("<id>", "Environment ID")
        .description("Delete an environment")
        .action(async (id) => {
        await api.delete(`/api/environments/${id}`);
        if (isJSONMode()) {
            printJSON({ ok: true, id });
            return;
        }
        success(`Environment ${id} deleted`);
    });
}
//# sourceMappingURL=env.js.map