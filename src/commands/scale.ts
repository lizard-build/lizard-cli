import chalk from "chalk";
import { Command } from "commander";
import { api } from "../lib/api.js";
import { resolveProjectId } from "../lib/config.js";
import { getActiveServiceWithKind } from "../lib/resolve.js";
import { success, isJSONMode, printJSON } from "../lib/format.js";

// Discrete sizes the platform actually supports. The node-agent silently
// clamps VMs to 1-4 CPU and 512-4096 MB — anything over that is accepted at
// the API layer but the running VM lands at the clamp. Reject on the client
// so the user sees the limit instead of a fake success.
const ALLOWED_CPU_CORES = [1, 2, 3, 4] as const;
const ALLOWED_MEMORY_MB = [512, 1024, 2048, 4096] as const;
// Storage tiers match the addon size selector on the dashboard. Addon-only —
// apps don't have a resizable data volume on this path.
const ALLOWED_STORAGE_MB = [512, 1024, 2048, 4096, 8192, 16384] as const;

/**
 * `lizard scale` — service scaling.
 *   --replicas <n>     change replica count (1-10) — apps only
 *   --cpu <cores>      CPU cap; allowed: 1, 2, 3, 4
 *   --memory <mb>      memory cap; allowed: 512, 1024, 2048, 4096
 *   --storage <mb>     data volume size; addons only, grow-only;
 *                      allowed: 512, 1024, 2048, 4096, 8192, 16384
 */
export function registerScale(program: Command) {
  program
    .command("scale")
    .description("Scale a service (replicas / CPU / memory / storage)")
    .argument("[service]", "Service name or ID (defaults to linked)")
    .option("-s, --service <name>", "Service name or ID")
    .option("-p, --project <id>", "Project name or ID")
    .option("--replicas <n>", "Number of replicas (1-10), apps only", parseIntOption)
    .option("--cpu <cores>", `CPU cap, whole cores (allowed: ${ALLOWED_CPU_CORES.join(", ")})`, parseIntOption)
    .option("--memory <mb>", `Memory cap in MB (allowed: ${ALLOWED_MEMORY_MB.join(", ")})`, parseIntOption)
    .option("--storage <mb>", `Data volume size in MB, addons only, grow-only (allowed: ${ALLOWED_STORAGE_MB.join(", ")})`, parseIntOption)
    .action(async (serviceArg: string | undefined, opts, _cmd) => {
      const projectId = await resolveProjectId(opts.project);
      const service = await getActiveServiceWithKind(serviceArg || opts.service, projectId);

      if (
        opts.replicas === undefined &&
        opts.cpu === undefined &&
        opts.memory === undefined &&
        opts.storage === undefined
      ) {
        throw new Error("Pass at least one of: --replicas, --cpu, --memory, --storage.");
      }

      if (opts.replicas !== undefined && (opts.replicas < 1 || opts.replicas > 10)) {
        throw new Error(`--replicas must be between 1 and 10 (got ${opts.replicas}).`);
      }
      if (opts.cpu !== undefined && !(ALLOWED_CPU_CORES as readonly number[]).includes(opts.cpu)) {
        throw new Error(
          `--cpu ${opts.cpu} not supported. Allowed: ${ALLOWED_CPU_CORES.join(", ")} cores.`,
        );
      }
      if (opts.memory !== undefined && !(ALLOWED_MEMORY_MB as readonly number[]).includes(opts.memory)) {
        throw new Error(
          `--memory ${opts.memory} not supported. Allowed: ${ALLOWED_MEMORY_MB.join(", ")} MB.`,
        );
      }
      if (opts.storage !== undefined && !(ALLOWED_STORAGE_MB as readonly number[]).includes(opts.storage)) {
        throw new Error(
          `--storage ${opts.storage} not supported. Allowed: ${ALLOWED_STORAGE_MB.join(", ")} MB.`,
        );
      }

      if (service.kind === "addon") {
        if (opts.replicas !== undefined) {
          throw new Error("Addons run as a single VM and don't support --replicas.");
        }
        return scaleAddon(projectId, service, opts.cpu, opts.memory, opts.storage);
      }

      if (opts.storage !== undefined) {
        throw new Error("--storage is only supported for addons (postgres, redis, mongo, mysql).");
      }

      // App path: replicas go to /scale; cpu/memory go to the general app PATCH
      // (which triggers VM resize via resizeAppOnNode).
      const resizeBody: Record<string, unknown> = {};
      if (opts.cpu !== undefined) resizeBody.cpuLimit = `${opts.cpu}`;
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

interface AddonRecord {
  id: string;
  status?: string;
  config?: {
    vcpu?: number;
    vcpuLimit?: number;
    memoryMb?: number;
    memoryMbLimit?: number;
    storageSize?: string;
  };
}

async function scaleAddon(
  projectId: string,
  service: { id: string; name: string },
  cpu: number | undefined,
  memory: number | undefined,
  storageMb: number | undefined,
): Promise<void> {
  // /limits requires BOTH vcpu and memoryMb; fetch the current config so partial
  // flag combos (e.g. --cpu only) don't accidentally wipe the other axis. Also
  // gives us the current storageSize for the grow-only check below.
  const addons = await api.get<AddonRecord[]>(`/api/projects/${projectId}/addons`);
  const current = addons.find((a) => a.id === service.id);
  if (!current) throw new Error(`Addon "${service.name}" not found in project.`);

  const cfg = current.config ?? {};
  const summary: Record<string, unknown> = { id: service.id, kind: "addon" };

  if (cpu !== undefined || memory !== undefined) {
    const currentVcpu = cfg.vcpuLimit ?? cfg.vcpu ?? 1;
    const currentMemoryMb = cfg.memoryMbLimit ?? cfg.memoryMb ?? 512;
    const body = {
      vcpu: cpu ?? currentVcpu,
      memoryMb: memory ?? currentMemoryMb,
    };
    summary.limits = await api.put(
      `/api/projects/${projectId}/addons/${service.id}/limits`,
      body,
    );
    Object.assign(summary, body);
  }

  if (storageMb !== undefined) {
    const currentMb = cfg.storageSize ? parseStorageToMb(cfg.storageSize) : 0;
    if (currentMb > 0 && storageMb <= currentMb) {
      throw new Error(
        `--storage ${storageMb} MB is not larger than current ${currentMb} MB. Storage is grow-only.`,
      );
    }
    const storageSize = storageMbToK8s(storageMb);
    summary.resize = await api.post(
      `/api/projects/${projectId}/addons/${service.id}/resize`,
      { storageSize },
    );
    summary.storageSize = storageSize;
  }

  if (isJSONMode()) {
    printJSON(summary);
  } else {
    success(`Scaled ${chalk.bold(service.name)} (addon)`);
  }
}

/** 1024 → "1Gi", 512 → "512Mi". Matches the addon size selector on the dashboard. */
function storageMbToK8s(mb: number): string {
  return mb % 1024 === 0 ? `${mb / 1024}Gi` : `${mb}Mi`;
}

/** Inverse of storageMbToK8s for grow-only comparison; supports Gi/Mi/Ti. */
function parseStorageToMb(size: string): number {
  if (size.endsWith("Gi")) return parseFloat(size) * 1024;
  if (size.endsWith("Mi")) return parseFloat(size);
  if (size.endsWith("Ti")) return parseFloat(size) * 1024 * 1024;
  return 0;
}

function parseIntOption(v: string): number {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) throw new Error(`Invalid number: ${v}`);
  return n;
}
