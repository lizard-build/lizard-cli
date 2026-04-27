import { Command } from "commander";
import { api } from "../lib/api.js";
import { resolveProjectId } from "../lib/config.js";
import { success, isJSONMode, printJSON } from "../lib/format.js";

function parsePairs(pairs: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of pairs) {
    const eqIdx = pair.indexOf("=");
    if (eqIdx < 1) throw new Error(`Invalid format: "${pair}". Use KEY=value`);
    out[pair.slice(0, eqIdx)] = pair.slice(eqIdx + 1);
  }
  return out;
}

export function registerService(program: Command) {
  const service = program
    .command("service")
    .description("Manage service configuration");

  service
    .command("set")
    .argument("[pairs...]", "KEY=value pairs to set")
    .description("Apply (or stage) project config env vars")
    .option("-e, --env <envId>", "Target a specific environment instead of the project")
    .option("--stage", "Stage changes without applying to running services")
    .action(async (pairs: string[], opts) => {
      const newVars = pairs.length > 0 ? parsePairs(pairs) : {};

      if (opts.env) {
        // Environment-scoped apply
        const envId: string = opts.env;

        // Fetch current env vars and merge
        const current = await api.get<{ envVars: Record<string, string> }>(
          `/api/environments/${envId}/config`,
        );
        const merged = { ...current.envVars, ...newVars };

        const result = await api.post<{ ok: boolean; staged: boolean }>(
          `/api/environments/${envId}/config/apply`,
          { envVars: merged, stage: opts.stage ?? false },
        );

        if (isJSONMode()) {
          printJSON(result);
          return;
        }

        if (result.staged) {
          success(`Config staged for environment ${envId} (not yet applied)`);
        } else {
          success(`Config applied to environment ${envId}`);
        }
        return;
      }

      // Project-scoped apply
      const projectId = resolveProjectId(program.opts().project);

      // Fetch current env vars and merge
      const current = await api.get<{ envVars: Record<string, string> }>(
        `/api/projects/${projectId}/env`,
      );
      const merged = { ...current.envVars, ...newVars };

      const result = await api.post<{ ok: boolean; staged: boolean }>(
        `/api/projects/${projectId}/config/apply`,
        { envVars: merged, stage: opts.stage ?? false },
      );

      if (isJSONMode()) {
        printJSON(result);
        return;
      }

      if (result.staged) {
        success("Config staged (not yet applied to running services)");
      } else {
        success(`${Object.keys(merged).length} env var(s) applied to project`);
      }
    });
}
