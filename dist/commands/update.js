import chalk from "chalk";
import { info, success, isJSONMode, printJSON } from "../lib/format.js";
import { CURRENT_VERSION, getLatestVersion, selfUpdate } from "../lib/updater.js";
export function registerUpdate(program) {
    program
        .command("update")
        .description("Update Lizard CLI to latest version")
        .option("--check", "Only check for updates without installing")
        .action(async (opts) => {
        const latest = await getLatestVersion();
        if (!latest) {
            info("Could not check for updates. Check your internet connection.");
            return;
        }
        const updateAvailable = latest !== CURRENT_VERSION;
        if (isJSONMode()) {
            printJSON({ currentVersion: CURRENT_VERSION, latestVersion: latest, updateAvailable });
            return;
        }
        if (!updateAvailable) {
            info(`Already up to date (v${CURRENT_VERSION})`);
            return;
        }
        if (opts.check) {
            info(`Update available: v${CURRENT_VERSION} → ${chalk.green("v" + latest)}`);
            info(chalk.dim(`Run \`lizard update\` to install`));
            return;
        }
        info(`Updating v${CURRENT_VERSION} → ${chalk.green("v" + latest)}...`);
        try {
            await selfUpdate((msg) => info(chalk.dim(msg)));
            success(`Updated to v${latest}`);
        }
        catch (e) {
            throw new Error(`Update failed: ${e.message}`);
        }
    });
}
//# sourceMappingURL=update.js.map