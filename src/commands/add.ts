import chalk from "chalk";
import * as p from "@clack/prompts";
import { Command } from "commander";
import { api } from "../lib/api.js";
import { getProjectLink, updateProjectLink, DEFAULT_REGION } from "../lib/config.js";
import {
  success,
  info,
  isJSONMode,
  printJSON,
  isTTY,
  table,
} from "../lib/format.js";
import { validateName, addonRefName } from "../lib/name.js";

const CATALOG = [
  { name: "postgres", label: "PostgreSQL", description: "Relational database" },
  { name: "redis", label: "Redis", description: "In-memory key-value store" },
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

/** Most-useful env var to surface as a reference example for each addon type.
 *  Mirrors urlKey in lizard-client/src/components/AddonPanel.tsx. */
function addonExampleVar(type: string): string {
  switch (type) {
    case "postgres":
    case "mysql":
      return "DATABASE_URL";
    case "mongo":
      return "MONGODB_URL";
    case "redis":
      return "REDIS_URL";
    case "s3":
      return "S3_ENDPOINT";
    default:
      return "KEY";
  }
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
      "[types...]",
      "Addon type(s) to add (postgres / redis / s3). Multiple allowed: `add postgres redis s3`",
    )
    .description("Add a database, service, or repo to the project")
    .option(
      "-a, --addon <type...>",
      "Add one or more managed addons (multi-add: -a postgres -a redis -a s3)",
    )
    .option("-s, --service <name>", "Create an empty service with this name")
    .option("-r, --repo <repo>", "Create a service from a GitHub repo (owner/repo)")
    .option(
      "-v, --variables <kv>",
      "KEY=value pair to seed the service. Repeat for multiple: -v K1=v1 -v K2=v2. Ignored for managed addons.",
      (val: string, prev: string[]) => [...prev, val],
      [] as string[],
    )
    .option("-n, --name <name>", "Name used in ${{<name>.KEY}} templates and shown in the dashboard. Renamable; refs stay stable.")
    .option("--instance-name <name>", "(deprecated) alias for --name")
    .option("--list", "Show available database types")
    .action(async (types: string[], opts, command) => {
      const merged = command.optsWithGlobals();
      const projectFlag = merged.project;
      const region = merged.region ?? undefined;

      // ── --list: show DB catalog and exit ──────────────────────────────
      if (opts.list || (!types.length && !opts.addon && !opts.service && !opts.repo && !isTTY())) {
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

      if (opts.instanceName && !opts.name) {
        info(chalk.yellow("Warning: --instance-name is deprecated, use --name instead."));
        opts.name = opts.instanceName;
      }
      if (opts.name) {
        const err = validateName(opts.name);
        if (err) throw new Error(`Invalid --name: ${err}`);
      }

      // Resolve project up front so we fail before any wizard prompts or
      // API calls instead of after the user has filled out the wizard.
      const projectId = await resolveProject(projectFlag);

      // ── positional <types...> and/or -a <type...> ────────────────────
      const databases: string[] = [];
      const candidates = [...(opts.addon ?? []), ...types];
      for (const t of candidates) {
        const norm = normalizeDbName(t);
        if (!CATALOG.some((c) => c.name === norm)) {
          throw new Error(
            `Unknown addon "${t}". Available: ${CATALOG.map((c) => c.name).join(", ")}`,
          );
        }
        databases.push(norm);
      }

      // Nudge users off the verbose single-arg `-a` form toward `lizard add <type>`.
      if (opts.addon?.length === 1 && !types.length && !isJSONMode()) {
        info(chalk.dim(`Tip: shorter form — \`lizard add ${opts.addon[0]}\``));
      }

      if (databases.length > 0) {
        if (opts.variables?.length) {
          info(chalk.yellow("Warning: --variables is ignored for managed addons"));
        }
        const isSingle = databases.length === 1;
        for (const db of databases) {
          const cat = CATALOG.find((c) => c.name === db)!;
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
            ...(opts.name ? { name: opts.name } : {}),
          });

          if (isJSONMode()) printJSON(addon);
          else {
            success(`${cat.label} added`);
            const ref = addonRefName({ name: addon.name, type: (addon as any).type, addonType: addon.addonType });
            const exampleVar = addonExampleVar(db);
            if (ref) info(`  Name: ${chalk.bold(ref)}`);
            if (ref) {
              info("");
              info(chalk.dim(`  Reference the ${exampleVar} from other services:`));
              info(`    ${chalk.cyan(`\${{${ref}.${exampleVar}}}`)}`);
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
        const serviceName = opts.name || opts.service || opts.repo.split("/").pop() || "service";
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
        else {
          success(`Service ${chalk.bold(app.name)} created`);
          info("");
          info(chalk.dim(`  Reference this service's private URL from other services:`));
          info(`    ${chalk.cyan(`\${{${app.name}.LIZARD_PRIVATE_DOMAIN}}`)}`);
        }
        try {
          updateProjectLink({ serviceId: app.id, serviceName: app.name });
        } catch {}
        return;
      }

      // ── --service <name> (empty service) ──────────────────────────────
      if (opts.service) {
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
        else {
          success(`Service ${chalk.bold(app.name)} created`);
          info("");
          info(chalk.dim(`  Reference this service's private URL from other services:`));
          info(`    ${chalk.cyan(`\${{${app.name}.LIZARD_PRIVATE_DOMAIN}}`)}`);
        }
        try {
          updateProjectLink({ serviceId: app.id, serviceName: app.name });
        } catch {}
        return;
      }

      // ── No flags + no positional → interactive wizard ────────────────
      if (!types.length && isTTY()) {
        const kind = await p.select({
          message: "What do you need?",
          options: [
            { value: "database", label: "Database", hint: "postgres / redis" },
            { value: "s3", label: "S3 Bucket", hint: "S3-compatible object storage" },
            { value: "repo", label: "GitHub Repo", hint: "create a service from a repo" },
            { value: "service", label: "Empty Service", hint: "create a service to upload code into" },
          ],
        });
        if (p.isCancel(kind)) process.exit(5);

        if (kind === "database") {
          const sel = await p.select({
            message: "Select database",
            options: CATALOG.filter((c) => c.name !== "s3").map((c) => ({
              value: c.name,
              label: c.label,
              hint: c.description,
            })),
          });
          if (p.isCancel(sel)) process.exit(5);
          // recursively call with positional type
          await new Promise<void>((resolve) => {
            program.parseAsync(["add", sel as string], { from: "user" }).then(() => resolve());
          });
          return;
        }

        if (kind === "s3") {
          await new Promise<void>((resolve) => {
            program.parseAsync(["add", "s3"], { from: "user" }).then(() => resolve());
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
