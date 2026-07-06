import { Command } from "commander";
/**
 * `lizard scale` — service scaling.
 *   --replicas <n>     change replica count (1-10) — apps only
 *   --cpu <cores>      CPU cap; allowed: 1, 2, 3, 4
 *   --memory <mb>      memory cap in MB; any whole value 128-8192
 *   --storage <mb>     data volume size; addons only, grow-only;
 *                      allowed: 512, 1024, 2048, 4096, 8192, 16384
 */
export declare function registerScale(program: Command): void;
