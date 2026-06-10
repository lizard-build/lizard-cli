import chalk from "chalk";
import { info, success, isJSONMode, printJSON } from "../lib/format.js";
import { CURRENT_VERSION, getLatestVersion, selfUpdate, isStandaloneBinary } from "../lib/updater.js";
export function registerUpgrade(program) {
    program
        .command("upgrade")
        .description("Upgrade Lizard CLI to latest version")
        .option("--check", "Only check for updates without installing")
        .action(async (opts) => {
        const result = await getLatestVersion();
        if (result.kind === "rate-limited") {
            if (isJSONMode()) {
                printJSON({
                    currentVersion: CURRENT_VERSION,
                    error: { code: "rate_limited", resetAt: result.resetAt },
                });
                return;
            }
            const eta = result.resetAt > 0
                ? ` Try again in ~${Math.max(1, Math.ceil((result.resetAt * 1000 - Date.now()) / 60_000))} min.`
                : "";
            info(`GitHub API rate-limited (60 req/h per IP).${eta}`);
            return;
        }
        if (result.kind === "error") {
            if (isJSONMode()) {
                printJSON({
                    currentVersion: CURRENT_VERSION,
                    error: { code: "check_failed" },
                });
                return;
            }
            info("Could not check for updates. Check your internet connection.");
            return;
        }
        const latest = result.version;
        const updateAvailable = latest !== CURRENT_VERSION;
        if (isJSONMode() && opts.check) {
            printJSON({ currentVersion: CURRENT_VERSION, latestVersion: latest, updateAvailable });
            return;
        }
        if (!updateAvailable) {
            if (isJSONMode()) {
                printJSON({
                    currentVersion: CURRENT_VERSION,
                    latestVersion: latest,
                    updateAvailable: false,
                    upgraded: false,
                });
                return;
            }
            info(`Already up to date (v${CURRENT_VERSION})`);
            return;
        }
        if (opts.check) {
            info(`Update available: v${CURRENT_VERSION} → ${chalk.green("v" + latest)}`);
            info(chalk.dim(`Run \`lizard upgrade\` to install`));
            return;
        }
        // npm install — self-replacing process.execPath would overwrite the
        // user's node binary. Point at npm instead.
        if (!isStandaloneBinary()) {
            if (isJSONMode()) {
                printJSON({
                    currentVersion: CURRENT_VERSION,
                    latestVersion: latest,
                    updateAvailable: true,
                    upgraded: false,
                    method: "npm",
                    hint: "npm install -g @lizard-build/cli@latest",
                });
                return;
            }
            info(`Update available: v${CURRENT_VERSION} → ${chalk.green("v" + latest)}`);
            info(`This copy was installed via npm. Upgrade with:`);
            info(`  ${chalk.cyan("npm install -g @lizard-build/cli@latest")}`);
            return;
        }
        info(`Upgrading v${CURRENT_VERSION} → ${chalk.green("v" + latest)}...`);
        try {
            await selfUpdate((msg) => info(chalk.dim(msg)));
            if (isJSONMode()) {
                printJSON({
                    previousVersion: CURRENT_VERSION,
                    latestVersion: latest,
                    upgraded: true,
                });
            }
            else {
                success(`Upgraded to v${latest}`);
            }
        }
        catch (e) {
            throw new Error(`Upgrade failed: ${e.message}`);
        }
    });
}
//# sourceMappingURL=upgrade.js.map