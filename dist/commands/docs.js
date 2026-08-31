import open from "open";
import { success, isJSONMode, printJSON } from "../lib/format.js";
// Docs are served from the main host under /docs. The docs.lizard.build
// subdomain resolves but has no valid certificate, so opening it dumps the
// user on a TLS error page — don't switch back to it without checking.
const DOCS_URL = "https://lizard.build/docs";
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