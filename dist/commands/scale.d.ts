import { Command } from "commander";
/**
 * `lizard scale` — service scaling.
 *   --replicas <n>     change replica count
 *   --cpu <cores>      cap CPU
 *   --memory <mb>      cap memory
 */
export declare function registerScale(program: Command): void;
