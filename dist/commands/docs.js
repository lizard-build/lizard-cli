import open from "open";
import { success, isJSONMode, printJSON } from "../lib/format.js";
const DOCS_URL = "https://docs.lizard.build";
export function registerDocs(program) {
    program
        .command("docs")
        .description("Open Lizard documentation in browser")
        .action(async () => {
        // JSON / headless mode: report the URL instead of popping a browser
        if (isJSONMode()) {
            printJSON({ url: DOCS_URL, opened: false });
            return;
        }
        await open(DOCS_URL);
        success(`Opened ${DOCS_URL}`);
    });
}
//# sourceMappingURL=docs.js.map