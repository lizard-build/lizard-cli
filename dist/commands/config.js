import fs from "node:fs";
import path from "node:path";
import chalk from "chalk";
import ora from "ora";
import { api, withScope } from "../lib/api.js";
import { resolveProjectScope } from "../lib/resolve.js";
import { success, error, isJSONMode, printJSON } from "../lib/format.js";
export function registerConfig(program) {
    const config = program.command("config").description("Manage project configuration");
    config
        .command("apply")
        .description("Apply lizard-config.json to the project")
        .option("-p, --project <id>", "Project name, slug, or ID")
        .option("-f, --file <path>", "Path to config file (default: lizard-config.json)")
        .option("--dry-run", "Show what would change without applying")
        .action(async (opts) => {
        const filePath = opts.file
            ? path.resolve(opts.file)
            : path.join(process.cwd(), "lizard-config.json");
        // Throw instead of error()+exit so the central handler in index.ts
        // emits a JSON error envelope in --json / non-TTY mode.
        if (!fs.existsSync(filePath)) {
            throw new Error(`Config file not found: ${filePath}`);
        }
        let config;
        try {
            config = JSON.parse(fs.readFileSync(filePath, "utf-8"));
        }
        catch (e) {
            throw new Error(`Failed to parse config file: ${e.message}`);
        }
        const { projectId, scope } = await resolveProjectScope(opts.project);
        if (opts.dryRun) {
            printJSON({ dryRun: true, projectId, config });
            return;
        }
        const spinner = ora("Applying config...").start();
        try {
            const result = await api.post(withScope(`/api/projects/${projectId}/config:apply`, scope), config);
            spinner.stop();
            if (isJSONMode()) {
                printJSON(result);
                return;
            }
            const changed = [
                ...(result.services || []).filter((s) => s.changed?.length > 0),
                ...(result.addons || []).filter((a) => a.changed?.length > 0),
            ];
            if (changed.length === 0) {
                success("Config applied — nothing changed");
            }
            else {
                success(`Config applied (revision ${result.revision})`);
                for (const svc of result.services || []) {
                    if (svc.changed?.length > 0) {
                        console.log(`  ${chalk.cyan(svc.name)}: ${svc.changed.join(", ")}`);
                    }
                }
            }
        }
        catch (e) {
            spinner.stop();
            error(`Failed to apply config: ${e.message}`);
            process.exit(1);
        }
    });
}
//# sourceMappingURL=config.js.map