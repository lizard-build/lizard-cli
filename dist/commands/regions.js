import { api } from "../lib/api.js";
import { isJSONMode, printJSON, table } from "../lib/format.js";
export function registerRegions(program) {
    program
        .command("regions")
        .description("List available regions")
        .action(async () => {
        const regions = await api.get("/api/regions");
        if (isJSONMode()) {
            printJSON(regions);
            return;
        }
        if (regions.length === 0) {
            console.log("No regions available.");
            return;
        }
        table(["Code", "Name"], regions.map((r) => [r.code || r.id, r.name]));
    });
}
//# sourceMappingURL=regions.js.map