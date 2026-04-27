import chalk from "chalk";
import { Command } from "commander";
import { api } from "../lib/api.js";
import { resolveProjectId } from "../lib/config.js";
import { getActiveService } from "../lib/resolve.js";
import { success, isJSONMode, printJSON } from "../lib/format.js";

/**
 * `lizard scale` — Railway-style scaling.
 *   --replicas <n>     change replica count
 *   --region <code>    bind to a region
 *   --cpu <cores>      cap CPU
 *   --memory <mb>      cap memory
 */
export function registerScale(program: Command) {
  program
    .command("scale")
    .description("Scale a service across regions/replicas")
    .option("-s, --service <name>", "Service name or ID")
    .option("-p, --project <id>", "Project name or ID")
    .option("-e, --environment <name>", "Environment name or ID")
    .option("--replicas <n>", "Number of replicas", parseIntOption)
    .option("--region <code>", "Region code")
    .option("--cpu <cores>", "CPU cap (cores, supports decimals)", parseFloatOption)
    .option("--memory <mb>", "Memory cap (MB)", parseIntOption)
    .action(async (opts, _cmd) => {
      const projectId = resolveProjectId(opts.project);
      const service = await getActiveService(opts.service, projectId);

      const body: Record<string, unknown> = {};
      if (opts.replicas !== undefined) body.replicas = opts.replicas;
      if (opts.region) body.region = opts.region;
      if (opts.cpu !== undefined) body.cpuLimit = opts.cpu;
      if (opts.memory !== undefined) body.memoryLimit = opts.memory;

      if (Object.keys(body).length === 0) {
        throw new Error(
          "Pass at least one of: --replicas, --region, --cpu, --memory.",
        );
      }

      const result = await api
        .patch(`/api/apps/${service.id}/scale`, body)
        .catch((err: any) => {
          if (err?.status === 404) {
            throw new Error(
              "Scale endpoint not yet implemented. The API needs " +
                "`PATCH /api/apps/{id}/scale` with body { replicas?, region?, cpuLimit?, memoryLimit? }.",
            );
          }
          throw err;
        });

      if (isJSONMode()) printJSON(result || { id: service.id, ...body });
      else success(`Scaled ${chalk.bold(service.name)}`);
    });
}

function parseIntOption(v: string): number {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) throw new Error(`Invalid number: ${v}`);
  return n;
}

function parseFloatOption(v: string): number {
  const n = parseFloat(v);
  if (Number.isNaN(n)) throw new Error(`Invalid number: ${v}`);
  return n;
}
