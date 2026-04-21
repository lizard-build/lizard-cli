import ora from "ora";
import { api } from "../lib/api.js";
import { success, isJSONMode, printJSON } from "../lib/format.js";
export function registerRestart(program) {
    program
        .command("restart")
        .argument("<id>", "Service ID to restart")
        .description("Restart a service")
        .action(async (id) => {
        const spinner = ora("Restarting...").start();
        await api.post(`/api/apps/${id}/restart`);
        spinner.stop();
        if (isJSONMode()) {
            printJSON({ id, status: "restarting" });
        }
        else {
            success(`Service ${id} restarting`);
        }
    });
}
//# sourceMappingURL=restart.js.map