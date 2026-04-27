import { Command } from "commander";
/**
 * `lizard scale` — Railway-style scaling.
 *   --replicas <n>     change replica count
 *   --region <code>    bind to a region
 *   --cpu <cores>      cap CPU
 *   --memory <mb>      cap memory
 */
export declare function registerScale(program: Command): void;
