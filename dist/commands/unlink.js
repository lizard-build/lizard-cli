import { clearProjectLink } from "../lib/config.js";
import { isJSONMode, printJSON, success } from "../lib/format.js";
/**
 * `lizard unlink` — Railway-style. Drops the cwd↔project mapping.
 */
export function registerUnlink(program) {
    program
        .command("unlink")
        .description("Disassociate the current directory from any project")
        .action(() => {
        clearProjectLink();
        if (isJSONMode())
            printJSON({ status: "unlinked" });
        else
            success("Directory unlinked");
    });
}
//# sourceMappingURL=unlink.js.map