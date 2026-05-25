import open from "open";
import { resolveProjectId } from "../lib/config.js";
import { getBaseURL } from "../lib/api.js";
import { success } from "../lib/format.js";
export function registerOpen(program) {
    program
        .command("open")
        .description("Open project in browser")
        .option("-p, --project <id>", "Project name, slug, or ID")
        .action(async (opts) => {
        const projectId = await resolveProjectId(opts.project);
        const url = `${getBaseURL()}/projects/${projectId}`;
        await open(url);
        success("Opened in browser");
    });
}
//# sourceMappingURL=open.js.map