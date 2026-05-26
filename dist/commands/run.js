import { spawnSync } from "node:child_process";
import { api, withScope } from "../lib/api.js";
import { getProjectLink } from "../lib/config.js";
import { resolveProjectScope, resolveService } from "../lib/resolve.js";
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
        const { projectId, scope } = await resolveProjectScope(opts.project);
        const env = { ...process.env };
        // 1. project secrets
        const projectSecrets = await api.get(withScope(`/api/projects/${projectId}/secrets`, scope));
        for (const s of projectSecrets)
            env[s.key] = s.value;
        // 2. service / addon secrets (override project)
        if (opts.service !== false) {
            const serviceRef = typeof opts.service === "string" ? opts.service : getProjectLink()?.serviceId;
            if (serviceRef) {
                const svc = await resolveService(projectId, serviceRef);
                const path = svc.kind === "app"
                    ? withScope(`/api/apps/${svc.id}/secrets`, scope)
                    : withScope(`/api/projects/${projectId}/addons/${svc.id}/secrets`, scope);
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
        // argv-style spawn — no shell, so quoting / pipes / `;` in user-supplied
        // args are passed verbatim to the target program instead of being parsed
        // by /bin/sh. If the user wants a shell, they can invoke one explicitly:
        // `lizard run sh -c 'foo | bar'`.
        const result = spawnSync(args[0], args.slice(1), {
            env,
            stdio: "inherit",
        });
        if (result.error) {
            const code = result.error.code;
            if (code === "ENOENT") {
                console.error(`lizard run: command not found: ${args[0]}`);
                process.exit(127);
            }
            console.error(`lizard run: ${result.error.message}`);
            process.exit(1);
        }
        process.exit(result.status ?? 1);
    });
}
//# sourceMappingURL=run.js.map