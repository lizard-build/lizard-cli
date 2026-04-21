import chalk from "chalk";
import * as p from "@clack/prompts";
import { Command } from "commander";
import { api } from "../lib/api.js";
import { resolveProjectId } from "../lib/config.js";
import {
  success,
  info,
  isJSONMode,
  printJSON,
  isTTY,
  table,
} from "../lib/format.js";

const CATALOG = [
  { name: "postgres", label: "PostgreSQL", description: "Relational database" },
  { name: "redis", label: "Redis", description: "In-memory key-value store" },
  { name: "mysql", label: "MySQL", description: "Relational database" },
  { name: "mongodb", label: "MongoDB", description: "Document database" },
] as const;

export function registerAdd(program: Command) {
  program
    .command("add")
    .argument("[name]", "Service name from catalog (postgres, redis, mysql, mongodb)")
    .description("Add a service to the project")
    .option("--list", "Show available services")
    .option("--region <region>", "Region for the service")
    .action(async (name: string | undefined, opts) => {
      // Show catalog
      if (opts.list || (!name && !isTTY())) {
        if (isJSONMode()) {
          printJSON(CATALOG);
        } else {
          table(
            ["Name", "Description"],
            CATALOG.map((c) => [c.name, c.description]),
          );
        }
        return;
      }

      // Interactive selection
      if (!name) {
        const selected = await p.select({
          message: "Select service to add",
          options: CATALOG.map((c) => ({
            value: c.name,
            label: c.label,
            hint: c.description,
          })),
        });
        if (p.isCancel(selected)) process.exit(5);
        name = selected as string;
      }

      // Validate name is in catalog
      const catalogEntry = CATALOG.find((c) => c.name === name);
      if (!catalogEntry) {
        throw new Error(
          `Unknown service "${name}". Available: ${CATALOG.map((c) => c.name).join(", ")}`,
        );
      }

      const projectId = resolveProjectId(program.opts().project);
      const region = opts.region || program.opts().region;

      info(`Adding ${chalk.cyan(catalogEntry.label)}...`);

      const addon = await api.post<{
        id: string;
        name: string;
        addonType: string;
        status: string;
        hostname?: string;
        connectionString?: string;
        envVars?: Record<string, string>;
      }>(`/api/projects/${projectId}/addons`, {
        addonType: name,
        region,
      });

      if (isJSONMode()) {
        printJSON(addon);
        return;
      }

      success(`${catalogEntry.label} added`);

      if (addon.hostname) {
        info(`  Host: ${chalk.cyan(addon.hostname)}`);
      }
      if (addon.envVars) {
        info(chalk.dim("\n  Environment variables added to project:"));
        for (const [key, val] of Object.entries(addon.envVars)) {
          info(`  ${chalk.bold(key)}=${chalk.dim(val)}`);
        }
      }
    });
}
