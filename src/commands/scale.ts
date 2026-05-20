import chalk from "chalk";
import { Command } from "commander";
import { api } from "../lib/api.js";
import { resolveProjectId } from "../lib/config.js";
import { getActiveService } from "../lib/resolve.js";
import { success, isJSONMode, printJSON } from "../lib/format.js";

/**
 * `lizard scale` — service scaling.
 *   --replicas <n>     change replica count
 *   --cpu <cores>      cap CPU
 *   --memory <mb>      cap memory
 */
export function registerScale(program: Command) {
  program
    .command("scale")
    .description("Scale a service (replicas / CPU / memory)")
    .option("-s, --service <name>", "Service name or ID")
    .option("-p, --project <id>", "Project name or ID")
    .option("--replicas <n>", "Number of replicas", parseIntOption)
    .option("--cpu <cores>", "CPU cap (cores, supports decimals)", parseFloatOption)
    .option("--memory <mb>", "Memory cap (MB)", parseIntOption)
    .action(async (opts, _cmd) => {
      const projectId = await resolveProjectId(opts.project);
      const service = await getActiveService(opts.service, projectId);

      if (opts.replicas === undefined && opts.cpu === undefined && opts.memory === undefined) {
        throw new Error("Pass at least one of: --replicas, --cpu, --memory.");
      }

      // Replicas go to /scale; cpu/memory go to the general app PATCH (which triggers VM resize).
      const resizeBody: Record<string, unknown> = {};
      if (opts.cpu !== undefined) resizeBody.cpuLimit = cpuCoresToQuantity(opts.cpu);
      if (opts.memory !== undefined) resizeBody.memoryLimit = `${opts.memory}Mi`;

      const calls: Promise<unknown>[] = [];
      if (opts.replicas !== undefined) {
        calls.push(api.patch(`/api/apps/${service.id}/scale`, { replicas: opts.replicas }));
      }
      if (Object.keys(resizeBody).length > 0) {
        calls.push(api.patch(`/api/apps/${service.id}`, resizeBody));
      }

      const results = await Promise.all(calls);

      if (isJSONMode()) {
        printJSON({
          id: service.id,
          ...(opts.replicas !== undefined ? { replicas: opts.replicas } : {}),
          ...resizeBody,
          results,
        });
      } else {
        success(`Scaled ${chalk.bold(service.name)}`);
      }
    });
}

/** Convert decimal CPU cores to Kubernetes-style quantity string ("0.5" -> "500m", "2" -> "2000m"). */
function cpuCoresToQuantity(cores: number): string {
  return `${Math.round(cores * 1000)}m`;
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
