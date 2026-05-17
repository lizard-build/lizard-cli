import { Command } from "commander";
import open from "open";
import { success } from "../lib/format.js";

const DOCS_URL = "https://docs.lizard.build";

export function registerDocs(program: Command) {
  program
    .command("docs")
    .description("Open Lizard documentation in browser")
    .action(async () => {
      await open(DOCS_URL);
      success(`Opened ${DOCS_URL}`);
    });
}
