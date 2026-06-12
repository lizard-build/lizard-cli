import { Command } from "commander";
import open from "open";
import { resolveProjectId } from "../lib/config.js";
import { getBaseURL } from "../lib/api.js";
import { success, isJSONMode, printJSON } from "../lib/format.js";

export function registerOpen(program: Command) {
  program
    .command("open")
    .description("Open project in browser")
    .option("-p, --project <id>", "Project name, slug, or ID")
    .action(async (opts) => {
      const projectId = await resolveProjectId(opts.project);
      const url = `${getBaseURL()}/projects/${projectId}`;
      // JSON / headless mode: report the URL instead of popping a browser
      if (isJSONMode()) {
        printJSON({ url, opened: false });
        return;
      }
      await open(url);
      success("Opened in browser");
    });
}
