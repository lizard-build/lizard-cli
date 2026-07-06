import open from "open";
import { resolveProjectId } from "../lib/config.js";
import { api, getBaseURL } from "../lib/api.js";
import { success, isJSONMode, printJSON } from "../lib/format.js";
export function registerOpen(program) {
    program
        .command("open")
        .description("Open project in browser")
        .option("-p, --project <id>", "Project name, slug, or ID")
        .action(async (opts) => {
        const projectId = await resolveProjectId(opts.project);
        // The dashboard routes projects as `/<workspaceSlug>/<projectSlug>` —
        // there is no `/projects/<id>` route, so we must resolve both slugs.
        // `/api/projects` is the only endpoint that returns workspaceSlug.
        const projects = await api.get("/api/projects");
        const project = projects.find((p) => p.id === projectId);
        if (!project?.slug || !project.workspaceSlug) {
            throw new Error("Could not resolve project URL (missing slug).");
        }
        const url = `${getBaseURL()}/${project.workspaceSlug}/${project.slug}`;
        // JSON / headless mode: report the URL instead of popping a browser
        if (isJSONMode()) {
            printJSON({ url, opened: false });
            return;
        }
        await open(url);
        success("Opened in browser");
    });
}
//# sourceMappingURL=open.js.map