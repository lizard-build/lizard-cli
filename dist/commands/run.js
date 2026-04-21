import { execSync } from "node:child_process";
import { api } from "../lib/api.js";
import { resolveProjectId } from "../lib/config.js";
export function registerRun(program) {
    program
        .command("run")
        .argument("<command...>", "Command to run with project env vars")
        .description("Run a command with project secrets as env vars")
        .allowUnknownOption()
        .action(async (args) => {
        const projectId = resolveProjectId(program.opts().project);
        // Fetch secrets
        const secrets = await api.get(`/api/projects/${projectId}/secrets`);
        // Build env
        const env = { ...process.env };
        for (const s of secrets) {
            env[s.key] = s.value;
        }
        // Run command
        const cmd = args.join(" ");
        try {
            execSync(cmd, {
                env,
                stdio: "inherit",
                shell: process.env.SHELL || "/bin/sh",
            });
        }
        catch (err) {
            process.exit(err.status || 1);
        }
    });
}
//# sourceMappingURL=run.js.map