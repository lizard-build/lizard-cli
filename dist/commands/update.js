import chalk from "chalk";
import { info, isJSONMode, printJSON } from "../lib/format.js";
export function registerUpdate(program) {
    program
        .command("update")
        .description("Update Lizard CLI to latest version")
        .option("--check", "Only check for updates without installing")
        .action(async (opts) => {
        // Check npm for latest version
        try {
            const res = await fetch("https://registry.npmjs.org/@lizard/cli/latest");
            if (!res.ok)
                throw new Error("Failed to check for updates");
            const data = (await res.json());
            if (isJSONMode()) {
                printJSON({
                    currentVersion: "0.1.0",
                    latestVersion: data.version,
                    updateAvailable: data.version !== "0.1.0",
                });
                return;
            }
            if (data.version === "0.1.0") {
                info("Already up to date (v0.1.0)");
                return;
            }
            if (opts.check) {
                info(`Update available: v0.1.0 → v${data.version}`);
                info(chalk.dim(`Run \`lizard update\` to install`));
                return;
            }
            info(`Updating to v${data.version}...`);
            const { execSync } = await import("node:child_process");
            execSync("npm install -g @lizard/cli@latest", { stdio: "inherit" });
        }
        catch {
            info("Could not check for updates. Run `npm update -g @lizard/cli` manually.");
        }
    });
}
//# sourceMappingURL=update.js.map