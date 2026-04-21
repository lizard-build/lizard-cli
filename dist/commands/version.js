import { isJSONMode, printJSON } from "../lib/format.js";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
function getVersion() {
    try {
        // Try to read from package.json
        const __dirname = dirname(fileURLToPath(import.meta.url));
        const pkgPath = join(__dirname, "..", "..", "package.json");
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
        return pkg.version || "0.1.0";
    }
    catch {
        return "0.1.0";
    }
}
export function registerVersion(program) {
    program
        .command("version")
        .description("Show CLI version")
        .action(() => {
        const version = getVersion();
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