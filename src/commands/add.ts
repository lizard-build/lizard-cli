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
  { name: "mongo", label: "MongoDB", description: "Document database", aliases: ["mongodb"] },
  { name: "s3", label: "S3 Bucket", description: "S3-compatible object storage" },
] as const;

async function detectPortFromDockerfile(repo: string): Promise<number | undefined> {
  const repoPath = repo.startsWith("http") ? repo.replace(/^https?:\/\/github\.com\//, "") : repo;
  for (const branch of ["main", "master"]) {
    try {
      const res = await fetch(
        `https://raw.githubusercontent.com/${repoPath}/${branch}/Dockerfile`,
        { signal: AbortSignal.timeout(5000) },
      );
      if (!res.ok) continue;
      const text = await res.text();
      const match = text.match(/^EXPOSE\s+(\d+)/m);
      if (match) return parseInt(match[1], 10);
    } catch {}
  }
  return undefined;
}

function normalizeDbName(name: string): string {
  for (const c of CATALOG) {
    if (c.name === name) return c.name;
    if ((c as any).aliases?.includes(name)) return c.name;
  }
  return name;
}

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
      "[type]",
      "Addon type to add (postgres / redis / mysql / mongo / s3)",
    )
    .description("Add a database, service, or repo to the project")
    .option(
      "-d, --database <type...>",
      "Add one or more managed databases (multi-add: -d postgres -d redis)",
    )
    .option("-s, --service <name>", "Create an empty service with this name")
    .option("-r, --repo <repo>", "Create a service from a GitHub repo (owner/repo)")
    .option("-v, --variables <kv...>", "KEY=value pairs to seed the service")
    .option("--instance-name <name>", "Stable instance name used in ${{<name>.KEY}} templates (must be DNS-safe)")
    .option("--list", "Show available database types")
    .action(async (type: string | undefined, opts, command) => {
      const merged = command.optsWithGlobals();
      const projectFlag = merged.project;
      const region = merged.region;

      // ── --list: show DB catalog and exit ──────────────────────────────
      if (opts.list || (!type && !opts.database && !opts.service && !opts.repo && !isTTY())) {
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

      // ── positional <type> and/or -d <type...> ─────────────────────────
      const databases: string[] = [];
      if (opts.database?.length) databases.push(...opts.database.map(normalizeDbName));
      if (type) {
        const norm = normalizeDbName(type);
        if (CATALOG.some((c) => c.name === norm)) databases.push(norm);
      }

      // Nudge users off the verbose single-arg `-d` form toward `lizard add <type>`.
      if (opts.database?.length === 1 && !type && !isJSONMode()) {
        info(chalk.dim(`Tip: shorter form — \`lizard add ${opts.database[0]}\``));
      }

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
            ...(opts.instanceName ? { instanceName: opts.instanceName } : {}),
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
        const detectedPort = await detectPortFromDockerfile(opts.repo);
        if (detectedPort) info(`Detected port ${chalk.bold(detectedPort)} from Dockerfile`);
        const app = await api.post<{ id: string; name: string }>(
          `/api/projects/${projectId}/apps`,
          {
            name: serviceName,
            repoUrl: opts.repo.startsWith("http")
              ? opts.repo
              : `https://github.com/${opts.repo}`,
            region,
            variables,
            ...(detectedPort ? { containerPort: detectedPort } : {}),
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
            region,
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
      if (!type && isTTY()) {
        const kind = await p.select({
          message: "What do you need?",
          options: [
            { value: "database", label: "Database", hint: "postgres / redis / mysql / mongodb" },
            { value: "repo", label: "GitHub Repo", hint: "create a service from a repo" },
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
          // recursively call with positional type
          await new Promise<void>((resolve) => {
            program.parseAsync(["add", sel as string], { from: "user" }).then(() => resolve());
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
        "No service type specified. Examples:\n" +
          "  lizard add postgres        Add a managed database\n" +
          "  lizard add -r owner/repo   Create a service from a GitHub repo\n" +
          "  lizard add -s my-service   Empty service",
      );
    });
}
