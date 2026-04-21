import * as p from "@clack/prompts";
import ora from "ora";
import { api } from "../lib/api.js";
import { resolveProjectId } from "../lib/config.js";
import { success, isJSONMode, printJSON, isTTY } from "../lib/format.js";
export function registerRestart(program) {
    program
        .command("restart")
        .argument("[id]", "App ID to restart")
        .description("Restart an app")
        .action(async (id) => {
        if (!id) {
            if (!isTTY())
                throw new Error("Provide an app ID or run interactively");
            const projectId = resolveProjectId(program.opts().project);
            const data = await api.get(`/api/projects/${projectId}/services`);
            const apps = data.apps || [];
            if (apps.length === 0)
                throw new Error("No apps in project");
            if (apps.length === 1) {
                id = apps[0].id;
            }
            else {
                const selected = await p.select({
                    message: "Select app to restart",
                    options: apps.map((a) => ({
                        value: a.id,
                        label: a.name || a.id,
                        hint: a.status,
                    })),
                });
                if (p.isCancel(selected))
                    process.exit(5);
                id = selected;
            }
        }
        const spinner = ora("Restarting...").start();
        await api.post(`/api/apps/${id}/restart`);
        spinner.stop();
        if (isJSONMode()) {
            printJSON({ id, status: "restarting" });
        }
        else {
            success(`Restarting`);
        }
    });
}
//# sourceMappingURL=restart.js.map