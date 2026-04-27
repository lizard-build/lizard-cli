import chalk from "chalk";
import * as p from "@clack/prompts";
import { Command } from "commander";
import { api } from "../lib/api.js";
import { getProjectLink, updateProjectLink } from "../lib/config.js";
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

function parseVariables(pairs: string[] | undefined): Record<string, string> {
  if (!pairs?.length) return {};
  const out: Record<string, string> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq < 1) throw new Error(`Invalid variable: "${pair}". Use KEY=value`);
    out[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return out;
}

export function registerAdd(program: Command) {
  program
    .command("add")
    .argument(
      "[name]",
      "Database type (postgres/redis/mysql/mongodb) — kept for backwards compat",
    )
    .description("Add a database, service, or repo/image to the project")
    .option(
      "-d, --database <type...>",
      "Add a managed database (postgres/redis/mysql/mongodb)",
    )
    .option("-s, --service <name>", "Create an empty service with this name")
    .option("-r, --repo <repo>", "Create a service from a GitHub repo (owner/repo)")
    .option("-i, --image <image>", "Create a service from a Docker image")
    .option("-v, --variables <kv...>", "KEY=value pairs to seed the service")
    .option("-p, --project <name>", "Project name or ID")
    .option("--region <region>", "Region for the service")
    .option("--list", "Show available database types")
    .action(async (name: string | undefined, opts) => {
      const projectFlag = opts.project;
      const region = opts.region;

      // ── --list: show DB catalog and exit ──────────────────────────────
      if (opts.list || (!name && !opts.database && !opts.service && !opts.repo && !opts.image && !isTTY())) {
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

      const variables = parseVariables(opts.variables);

      // ── -d <type...> or positional <name> for backwards compat ────────
      const databases: string[] = [];
      if (opts.database?.length) databases.push(...opts.database);
      if (name && CATALOG.some((c) => c.name === name)) databases.push(name);

      if (databases.length > 0) {
        const projectId = await resolveProject(projectFlag);
        const isSingle = databases.length === 1;
        for (const db of databases) {
          const cat = CATALOG.find((c) => c.name === db);
          if (!cat) {
            throw new Error(
              `Unknown database "${db}". Available: ${CATALOG.map((c) => c.name).join(", ")}`,
            );
          }
          info(`Adding ${chalk.cyan(cat.label)}...`);
          const addon = await api.post<{
            id: string;
            name: string;
            addonType: string;
            status: string;
            hostname?: string;
            envVars?: Record<string, string>;
          }>(`/api/projects/${projectId}/addons`, {
            type: db,
            region,
            variables,
          });

          if (isJSONMode()) printJSON(addon);
          else {
            success(`${cat.label} added`);
            if (addon.hostname) info(`  Host: ${chalk.cyan(addon.hostname)}`);
            if (addon.envVars) {
              info(chalk.dim("\n  Environment variables:"));
              for (const [k, v] of Object.entries(addon.envVars)) {
                info(`  ${chalk.bold(k)}=${chalk.dim(v)}`);
              }
            }
          }

          if (isSingle) {
            try {
              updateProjectLink({ serviceId: addon.id, serviceName: addon.name });
            } catch {}
          }
        }
        return;
      }

      // ── -r <repo> ─────────────────────────────────────────────────────
      if (opts.repo) {
        const projectId = await resolveProject(projectFlag);
        const serviceName = opts.service || opts.repo.split("/").pop() || "service";
        info(`Creating service ${chalk.bold(serviceName)} from ${chalk.cyan(opts.repo)}...`);
        const app = await api.post<{ id: string; name: string }>(
          `/api/projects/${projectId}/apps`,
          {
            name: serviceName,
            repoUrl: opts.repo.startsWith("http")
              ? opts.repo
              : `https://github.com/${opts.repo}`,
            variables,
          },
        );
        if (isJSONMode()) printJSON(app);
        else success(`Service ${chalk.bold(app.name)} created`);
        try {
          updateProjectLink({ serviceId: app.id, serviceName: app.name });
        } catch {}
        return;
      }

      // ── -i <image> ────────────────────────────────────────────────────
      if (opts.image) {
        const projectId = await resolveProject(projectFlag);
        const serviceName =
          opts.service || opts.image.split(":")[0].split("/").pop() || "service";
        info(`Creating service ${chalk.bold(serviceName)} from image ${chalk.cyan(opts.image)}...`);
        const app = await api.post<{ id: string; name: string }>(
          `/api/projects/${projectId}/apps`,
          {
            name: serviceName,
            image: opts.image,
            variables,
          },
        );
        if (isJSONMode()) printJSON(app);
        else success(`Service ${chalk.bold(app.name)} created`);
        try {
          updateProjectLink({ serviceId: app.id, serviceName: app.name });
        } catch {}
        return;
      }

      // ── --service <name> (empty service) ──────────────────────────────
      if (opts.service) {
        const projectId = await resolveProject(projectFlag);
        info(`Creating empty service ${chalk.bold(opts.service)}...`);
        const app = await api.post<{ id: string; name: string }>(
          `/api/projects/${projectId}/apps`,
          {
            name: opts.service,
            variables,
          },
        );
        if (isJSONMode()) printJSON(app);
        else success(`Service ${chalk.bold(app.name)} created`);
        try {
          updateProjectLink({ serviceId: app.id, serviceName: app.name });
        } catch {}
        return;
      }

      // ── No flags + no positional → interactive wizard ────────────────
      if (!name && isTTY()) {
        const kind = await p.select({
          message: "What do you need?",
          options: [
            { value: "database", label: "Database", hint: "postgres / redis / mysql / mongodb" },
            { value: "repo", label: "GitHub Repo", hint: "create a service from a repo" },
            { value: "image", label: "Docker Image", hint: "create a service from an image" },
            { value: "service", label: "Empty Service", hint: "create a service to upload code into" },
          ],
        });
        if (p.isCancel(kind)) process.exit(5);

        if (kind === "database") {
          const sel = await p.select({
            message: "Select database",
            options: CATALOG.map((c) => ({ value: c.name, label: c.label, hint: c.description })),
          });
          if (p.isCancel(sel)) process.exit(5);
          // recursively call with -d
          await new Promise<void>((resolve) => {
            program.parseAsync(["add", "-d", sel as string], { from: "user" }).then(() => resolve());
          });
          return;
        }

        if (kind === "repo") {
          const repo = await p.text({ message: "Repo (owner/name)" });
          if (p.isCancel(repo)) process.exit(5);
          const svc = await p.text({ message: "Service name", placeholder: String(repo).split("/").pop() });
          if (p.isCancel(svc)) process.exit(5);
          await new Promise<void>((resolve) => {
            program
              .parseAsync(["add", "-r", String(repo), "-s", String(svc) || ""], { from: "user" })
              .then(() => resolve());
          });
          return;
        }

        if (kind === "image") {
          const img = await p.text({ message: "Image (e.g. nginx:alpine)" });
          if (p.isCancel(img)) process.exit(5);
          const svc = await p.text({ message: "Service name" });
          if (p.isCancel(svc)) process.exit(5);
          await new Promise<void>((resolve) => {
            program
              .parseAsync(["add", "-i", String(img), "-s", String(svc) || ""], { from: "user" })
              .then(() => resolve());
          });
          return;
        }

        if (kind === "service") {
          const svc = await p.text({ message: "Service name" });
          if (p.isCancel(svc)) process.exit(5);
          await new Promise<void>((resolve) => {
            program.parseAsync(["add", "-s", String(svc)], { from: "user" }).then(() => resolve());
          });
          return;
        }
      }

      throw new Error(
        "No service type specified. Use one of:\n" +
          "  --database <type>   Add a database (postgres/redis/mysql/mongodb)\n" +
          "  --service <name>    Create an empty service\n" +
          "  --repo <repo>       Create a service from a GitHub repo\n" +
          "  --image <image>     Create a service from a Docker image",
      );
    });
}
