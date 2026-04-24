import chalk from "chalk";
import * as p from "@clack/prompts";
import { Command } from "commander";
import { api } from "../lib/api.js";
import { getProjectLink } from "../lib/config.js";
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

interface Project {
  id: string;
  name: string;
  slug: string;
}

/**
 * Resolve a project by name/slug/id. Name-based lookup hits /api/projects and
 * matches against the list. Falls back to the cwd-linked project when no
 * -p/--project is supplied.
 */
async function resolveProject(flagValue: string | undefined): Promise<string> {
  if (flagValue) {
    const projects = await api.get<Project[]>("/api/projects");
    const match = projects.find(
      (pr) =>
        pr.id === flagValue ||
        pr.slug === flagValue ||
        pr.name === flagValue,
    );
    if (!match) {
      throw new Error(
        `Project "${flagValue}" not found. Available: ${projects.map((p) => p.name).join(", ") || "(none)"}`,
      );
    }
    return match.id;
  }

  const link = getProjectLink();
  if (link?.projectId) return link.projectId;

  throw new Error(
    "No project linked to this directory. Pass -p <project-name> or run `lizard init`.",
  );
}

export function registerAdd(program: Command) {
  program
    .command("add")
    .argument("[name]", "Service name from catalog (postgres, redis, mysql, mongodb)")
    .description("Add a service to the project")
    .option("-p, --project <name>", "Project name or ID")
    .option("--list", "Show available services")
    .option("--region <region>", "Region for the service")
    .action(async (name: string | undefined, opts) => {
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

      const catalogEntry = CATALOG.find((c) => c.name === name);
      if (!catalogEntry) {
        throw new Error(
          `Unknown service "${name}". Available: ${CATALOG.map((c) => c.name).join(", ")}`,
        );
      }

      const projectId = await resolveProject(opts.project || program.opts().project);
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
        type: name,
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
