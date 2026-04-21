import { Command } from "commander";
import { api } from "../lib/api.js";
import { isJSONMode, printJSON, table } from "../lib/format.js";

interface Region {
  id: string;
  name: string;
  code: string;
  endpoint?: string;
}

export function registerRegions(program: Command) {
  const region = program
    .command("region")
    .description("Region management");

  region
    .command("list")
    .description("List available regions")
    .action(async () => {
      const regions = await api.get<Region[]>("/api/regions");

      if (isJSONMode()) {
        printJSON(regions);
        return;
      }

      if (regions.length === 0) {
        console.log("No regions available.");
        return;
      }

      table(
        ["Code", "Name"],
        regions.map((r) => [r.code || r.id, r.name]),
      );
    });
}
