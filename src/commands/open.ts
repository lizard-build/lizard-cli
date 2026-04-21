import { Command } from "commander";
import open from "open";
import { resolveProjectId } from "../lib/config.js";
import { getBaseURL } from "../lib/api.js";
import { success } from "../lib/format.js";

export function registerOpen(program: Command) {
  program
    .command("open")
    .description("Open project in browser")
    .action(async () => {
      const projectId = resolveProjectId(program.opts().project);
      const url = `${getBaseURL()}/projects/${projectId}`;
      await open(url);
      success("Opened in browser");
    });
}
