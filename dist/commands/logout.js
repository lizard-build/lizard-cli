import { clearCredentials } from "../lib/auth.js";
import { success, isJSONMode, printJSON } from "../lib/format.js";
export function registerLogout(program) {
    program
        .command("logout")
        .description("Log out of Lizard")
        .action(async () => {
        clearCredentials();
        if (isJSONMode()) {
            printJSON({ status: "logged_out" });
        }
        else {
            success("Logged out");
        }
    });
}
//# sourceMappingURL=logout.js.map