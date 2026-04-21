import { isJSONMode, printJSON } from "../lib/format.js";
import { CURRENT_VERSION } from "../lib/updater.js";
export function registerVersion(program) {
    program
        .command("version")
        .description("Show CLI version")
        .action(() => {
        const version = CURRENT_VERSION;
        if (isJSONMode()) {
            printJSON({
                version,
                platform: process.platform,
                arch: process.arch,
                node: process.version,
            });
        }
        else {
            console.log(`lizard v${version}`);
            console.log(`${process.platform}/${process.arch} node/${process.version}`);
        }
    });
}
//# sourceMappingURL=version.js.map