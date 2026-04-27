import { Command } from "commander";
/**
 * `lizard down` — like `railway down`. Stops the deployment of a service
 * (or destroys the service when `--remove` is set, matching `destroy`).
 */
export declare function registerDown(program: Command): void;
