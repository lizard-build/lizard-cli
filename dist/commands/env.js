import { info } from "../lib/format.js";
const COMING_SOON = "Environments are not yet available. Coming soon.";
export function registerEnv(program) {
    const env = program
        .command("env")
        .description("Manage environments");
    env
        .command("create")
        .argument("<name>", "Environment name")
        .description("Create a new environment")
        .action(async () => {
        info(COMING_SOON);
    });
    env
        .command("list")
        .description("List environments")
        .action(async () => {
        info(COMING_SOON);
    });
    env
        .command("switch")
        .argument("<name>", "Environment name")
        .description("Switch to an environment")
        .action(async () => {
        info(COMING_SOON);
    });
    env
        .command("delete")
        .argument("<name>", "Environment name")
        .description("Delete an environment")
        .action(async () => {
        info(COMING_SOON);
    });
}
//# sourceMappingURL=env.js.map