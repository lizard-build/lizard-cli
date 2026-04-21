import { Command } from "commander";
import { info } from "../lib/format.js";

const COMING_SOON = "Snapshots are not yet available. Coming soon.";

export function registerSnapshot(program: Command) {
  const snapshot = program
    .command("snapshot")
    .description("Manage app snapshots");

  snapshot
    .command("create")
    .description("Create a new snapshot")
    .option("--name <name>", "Snapshot name")
    .action(async () => {
      info(COMING_SOON);
    });

  snapshot
    .command("list")
    .description("List snapshots")
    .action(async () => {
      info(COMING_SOON);
    });

  snapshot
    .command("restore")
    .argument("<name>", "Snapshot name")
    .description("Restore from a snapshot")
    .action(async () => {
      info(COMING_SOON);
    });

  snapshot
    .command("delete")
    .argument("<name>", "Snapshot name")
    .description("Delete a snapshot")
    .action(async () => {
      info(COMING_SOON);
    });
}
