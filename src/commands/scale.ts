import chalk from "chalk";
import { Command } from "commander";
import { api } from "../lib/api.js";
import { resolveProjectId } from "../lib/config.js";
import { getActiveServiceWithKind } from "../lib/resolve.js";
import { success, isJSONMode, printJSON } from "../lib/format.js";

// Discrete tiers the dashboard slider exposes (CPU_OPTIONS / MEMORY_OPTIONS in
// lizard-client). The API and node-agent accept other values, but anything off
// the tier list lands in DB as a string the UI slider can't snap to — the row
// shows raw "3000m" and the slider falls to index 0. Mirror the UI tiers so the
// CLI and dashboard stay in lockstep.
const ALLOWED_CPU_CORES = [1, 2, 4] as const;
const ALLOWED_MEMORY_MB = [512, 1024, 2048, 4096] as const;
// Storage tiers match the addon size selector on the dashboard. Addon-only —
// apps don't have a resizable data volume on this path.
const ALLOWED_STORAGE_MB = [512, 1024, 2048, 4096, 8192, 16384] as const;

/**
 * `lizard scale` — service scaling.
 *   --replicas <n>     change replica count (1-10) — apps only
 *   --cpu <cores>      CPU cap; allowed: 1, 2, 4
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

      // App path — replicas go to /scale; cpu/memory go through config:apply
      // (PATCH /api/apps/:id was retired with 410 in favour of config:apply).
      const calls: Promise<unknown>[] = [];

      if (opts.replicas !== undefined) {
        calls.push(api.patch(`/api/apps/${service.id}/scale`, { replicas: opts.replicas }));
      }

      let configApplyResult: ConfigApplyResult | undefined;
      if (opts.cpu !== undefined || opts.memory !== undefined) {
        const serviceEntry: Record<string, unknown> = { id: service.id, name: service.name };
        if (opts.cpu !== undefined) serviceEntry.cpuLimit = `${opts.cpu * 1000}m`;
        if (opts.memory !== undefined) serviceEntry.memoryLimit = mbToK8s(opts.memory);
        calls.push(
          api.post<ConfigApplyResult>(`/api/projects/${projectId}/config:apply`, {
            services: [serviceEntry],
          }).then((r) => { configApplyResult = r; return r; }),
        );
      }

      await Promise.all(calls);
      if (configApplyResult) warnSideEffects(configApplyResult);

      if (isJSONMode()) {
        printJSON({
          id: service.id,
          ...(opts.replicas !== undefined ? { replicas: opts.replicas } : {}),
          ...(opts.cpu !== undefined ? { cpuLimit: `${opts.cpu * 1000}m` } : {}),
          ...(opts.memory !== undefined ? { memoryLimit: mbToK8s(opts.memory) } : {}),
        });
      } else {
        success(`Scaled ${chalk.bold(service.name)}`);
      }
    });
}

interface ConfigApplyResult {
  revision?: number;
  sideEffectFailures?: { op: string; error: string }[];
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

/** Warn the user about any deferred side-effect failures from a config:apply response. */
function warnSideEffects(result: ConfigApplyResult): void {
  if (!result.sideEffectFailures?.length) return;
  for (const f of result.sideEffectFailures) {
    process.stderr.write(chalk.yellow(`⚠ Side effect failed (${f.op}): ${f.error}\n`));
  }
}

async function scaleAddon(
  projectId: string,
  service: { id: string; name: string },
  cpu: number | undefined,
  memory: number | undefined,
  storageMb: number | undefined,
): Promise<void> {
  // Only pre-fetch addon list when --storage is passed — needed for the
  // grow-only check. cpu/memory go through config:apply which accepts partial
  // deltas, so no pre-fetch is needed for those axes.
  if (storageMb !== undefined) {
    const addons = await api.get<AddonRecord[]>(`/api/projects/${projectId}/addons`);
    const current = addons.find((a) => a.id === service.id);
    if (!current) throw new Error(`Addon "${service.name}" not found in project.`);
    const currentMb = current.config?.storageSize ? parseStorageToMb(current.config.storageSize) : 0;
    if (currentMb > 0 && storageMb <= currentMb) {
      throw new Error(
        `--storage ${storageMb} MB is not larger than current ${currentMb} MB. Storage is grow-only.`,
      );
    }
  }

  // Build the config:apply addon patch. All three axes are optional and can
  // be combined freely — the server writes only the fields present.
  const addonPatch: Record<string, unknown> = { id: service.id };
  if (cpu !== undefined || memory !== undefined) {
    const limits: Record<string, number> = {};
    if (cpu !== undefined) limits.vcpu = cpu;
    if (memory !== undefined) limits.memoryMb = memory;
    addonPatch.limits = limits;
  }
  if (storageMb !== undefined) {
    addonPatch.storageSize = mbToK8s(storageMb);
  }

  const result = await api.post<ConfigApplyResult>(`/api/projects/${projectId}/config:apply`, {
    addons: [addonPatch],
  });
  warnSideEffects(result);

  if (isJSONMode()) {
    printJSON({
      id: service.id,
      kind: "addon",
      ...(cpu !== undefined ? { vcpu: cpu } : {}),
      ...(memory !== undefined ? { memoryMb: memory } : {}),
      ...(storageMb !== undefined ? { storageSize: mbToK8s(storageMb) } : {}),
    });
  } else {
    success(`Scaled ${chalk.bold(service.name)} (addon)`);
  }
}

/** 1024 → "1Gi", 512 → "512Mi". Matches the dashboard size tiers (memory + addon storage). */
function mbToK8s(mb: number): string {
  return mb % 1024 === 0 ? `${mb / 1024}Gi` : `${mb}Mi`;
}

/** Inverse of mbToK8s for grow-only comparison; supports Gi/Mi/Ti. */
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
