import { execSync } from "node:child_process";
import { api } from "../lib/api.js";
import { resolveProjectId, getProjectLink } from "../lib/config.js";
import { resolveService } from "../lib/resolve.js";
/**
 * `lizard run <command...>` — run a local command with platform secrets in
 * the environment. Project-scope secrets are loaded first, then the linked
 * (or `-s <service>`) service overrides on key collisions, mirroring the
 * order the platform applies them on the server.
 *
 * Pass `-s <service>` to switch service without touching the link.
 * Pass `--no-service` to load only project-scope secrets.
 */
export function registerRun(program) {
    program
        .command("run")
        .argument("<command...>", "Command to run with platform env vars")
        .description("Run a command with project + service secrets injected")
        .option("-s, --service <name>", "Service to pull secrets from (defaults to linked)")
        .option("--no-service", "Skip service-scope secrets, project only")
        .option("-p, --project <id>", "Project ID (defaults to linked)")
        .allowUnknownOption()
        .action(async (args, opts) => {
        const projectId = resolveProjectId(opts.project);
        const env = { ...process.env };
        // 1. project secrets
        const projectSecrets = await api.get(`/api/projects/${projectId}/secrets`);
        for (const s of projectSecrets)
            env[s.key] = s.value;
        // 2. service / addon secrets (override project)
        if (opts.service !== false) {
            const serviceRef = typeof opts.service === "string" ? opts.service : getProjectLink()?.serviceId;
            if (serviceRef) {
                const svc = await resolveService(projectId, serviceRef);
                const path = svc.kind === "app"
                    ? `/api/apps/${svc.id}/secrets`
                    : `/api/projects/${projectId}/addons/${svc.id}/secrets`;
                const serviceSecrets = await api.get(path).catch((err) => {
                    if (err?.status === 404) {
                        if (svc.kind === "addon") {
                            console.warn(`warning: addon "${svc.name}" exposes no secrets endpoint yet ` +
                                `(needs GET ${path}). Falling back to project-only env.`);
                        }
                        return [];
                    }
                    throw err;
                });
                for (const s of serviceSecrets)
                    env[s.key] = s.value;
            }
        }
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