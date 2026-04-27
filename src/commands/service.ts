import chalk from "chalk";
import * as p from "@clack/prompts";
import { Command } from "commander";
import { api } from "../lib/api.js";
import { resolveProjectId, updateProjectLink, getProjectLink } from "../lib/config.js";
import { resolveService } from "../lib/resolve.js";
import { registerServiceSet } from "./service-set.js";
import { registerServiceShow } from "./service-show.js";
import {
  success,
  info,
  isJSONMode,
  printJSON,
  isTTY,
  table,
  statusColor,
} from "../lib/format.js";

interface ServicesResponse {
  apps?: any[];
  addons?: any[];
}

/**
 * `lizard service` — Railway-style group:
 *   - bare: link a service to cwd (legacy: `railway service <name>`)
 *   - list / link / status / delete / redeploy / restart / scale / logs
 */
export function registerService(program: Command) {
  const svc = program
    .command("service")
    .alias("svc")
    .argument(
      "[name]",
      "Service name to link (legacy form for `service link <name>`)",
    )
    .description("Manage services")
    .action(async (name: string | undefined, _opts, cmd) => {
      // No subcommand → behave like `service link`
      if (!name && cmd.args.length === 0) {
        await linkInteractive(cmd);
        return;
      }
      if (name) {
        await linkByName(cmd, name);
      }
    });

  // `service set` and `service show` — per-service configuration patches.
  // Live in their own files because the apply logic is substantial.
  registerServiceSet(svc);
  registerServiceShow(svc);

  svc
    .command("list")
    .alias("ls")
    .description("List services in the project")
    .action(async (opts, sub) => {
      const inherited = sub.parent?.opts() || {};
      const projectId = resolveProjectId(opts.project ?? inherited.project ?? program.opts().project);
      const data = await api.get<ServicesResponse>(
        `/api/projects/${projectId}/services`,
      );
      const apps = data.apps || [];
      const addons = data.addons || [];

      if (isJSONMode()) {
        printJSON({ apps, addons });
        return;
      }

      const linkedId = getProjectLink()?.serviceId;

      if (apps.length) {
        console.log(chalk.bold("Apps"));
        table(
          ["Name", "Status", "URL", "Linked"],
          apps.map((a: any) => [
            a.name || a.id,
            statusColor(a.status),
            a.domain ? chalk.cyan(`https://${a.domain}`) : chalk.dim("—"),
            a.id === linkedId ? chalk.green("✓") : "",
          ]),
        );
      }

      if (addons.length) {
        if (apps.length) console.log();
        console.log(chalk.bold("Addons"));
        table(
          ["Name", "Type", "Status", "Host"],
          addons.map((a: any) => [
            a.name || a.addonType,
            a.addonType,
            statusColor(a.status),
            a.hostname || chalk.dim("—"),
          ]),
        );
      }

      if (!apps.length && !addons.length) {
        console.log("No services. Use `lizard add`.");
      }
    });

  svc
    .command("link")
    .argument("[name]", "Service name or ID")
    .description("Link a service to the current directory")
    .action(async (name: string | undefined, _opts, sub) => {
      if (name) {
        await linkByName(sub, name);
      } else {
        await linkInteractive(sub);
      }
    });

  svc
    .command("status")
    .description("Show status of the linked or specified service")
    .option("-s, --service <name>", "Service name or ID")
    .option("-p, --project <id>", "Project name or ID")
    .action(async (opts) => {
      const projectId = resolveProjectId(opts.project);
      const target = opts.service || getProjectLink()?.serviceId;
      if (!target) throw new Error("No service specified or linked.");
      const svcInfo = await resolveService(projectId, target);

      const detail = await api.get<any>(
        svcInfo.kind === "app"
          ? `/api/apps/${svcInfo.id}`
          : `/api/projects/${projectId}/addons/${svcInfo.id}`,
      );

      if (isJSONMode()) {
        printJSON(detail);
        return;
      }

      console.log(chalk.bold(detail.name || svcInfo.name));
      console.log(`  status: ${statusColor(detail.status)}`);
      if (detail.domain) console.log(`  url: ${chalk.cyan(`https://${detail.domain}`)}`);
      if (detail.repo || detail.repoUrl) console.log(`  repo: ${detail.repo || detail.repoUrl}`);
      if (detail.image) console.log(`  image: ${detail.image}`);
      if (detail.builds?.length) {
        console.log(`  latest build: ${statusColor(detail.builds[0].status)}`);
      }
    });

  svc
    .command("delete")
    .alias("rm")
    .description("Delete a service")
    .option("-s, --service <name>", "Service name or ID")
    .option("-p, --project <id>", "Project name or ID")
    .option("-y, --yes", "Skip confirmation")
    .action(async (opts) => {
      const projectId = resolveProjectId(opts.project);
      const target = opts.service || getProjectLink()?.serviceId;
      if (!target) throw new Error("No service specified or linked.");
      const svcInfo = await resolveService(projectId, target);

      const yes = opts.yes;
      if (!yes) {
        if (!isTTY()) throw new Error("Use -y to confirm in non-interactive mode");
        const confirm = await p.confirm({
          message: `Delete ${chalk.bold(svcInfo.name)}? This is irreversible.`,
        });
        if (p.isCancel(confirm) || !confirm) process.exit(5);
      }

      if (svcInfo.kind === "app") {
        await api.delete(`/api/apps/${svcInfo.id}`);
      } else {
        await api.delete(`/api/projects/${projectId}/addons/${svcInfo.id}`);
      }

      // Clear link if we just deleted the linked service
      const link = getProjectLink();
      if (link?.serviceId === svcInfo.id) {
        updateProjectLink({ serviceId: undefined, serviceName: undefined });
      }

      if (isJSONMode()) {
        printJSON({ id: svcInfo.id, name: svcInfo.name, status: "deleted" });
      } else {
        success(`Service ${chalk.bold(svcInfo.name)} deleted`);
      }
    });

  svc
    .command("redeploy")
    .description("Redeploy the latest build of a service")
    .option("-s, --service <name>", "Service name or ID")
    .option("-p, --project <id>", "Project name or ID")
    .action(async (opts) => {
      const projectId = resolveProjectId(opts.project);
      const target = opts.service || getProjectLink()?.serviceId;
      if (!target) throw new Error("No service specified or linked.");
      const svcInfo = await resolveService(projectId, target);
      await api.post(`/api/apps/${svcInfo.id}/redeploy`);
      if (isJSONMode()) {
        printJSON({ id: svcInfo.id, status: "deploying" });
      } else {
        success(`Redeploy of ${chalk.bold(svcInfo.name)} started`);
      }
    });

  svc
    .command("restart")
    .description("Restart a service")
    .option("-s, --service <name>", "Service name or ID")
    .option("-p, --project <id>", "Project name or ID")
    .action(async (opts) => {
      const projectId = resolveProjectId(opts.project);
      const target = opts.service || getProjectLink()?.serviceId;
      if (!target) throw new Error("No service specified or linked.");
      const svcInfo = await resolveService(projectId, target);
      await api.post(`/api/apps/${svcInfo.id}/restart`);
      if (isJSONMode()) {
        printJSON({ id: svcInfo.id, status: "restarting" });
      } else {
        success(`${chalk.bold(svcInfo.name)} restarting`);
      }
    });

  svc
    .command("scale")
    .description("Scale a service across regions")
    .option("-s, --service <name>", "Service name or ID")
    .option("-p, --project <id>", "Project name or ID")
    .option("--replicas <n>", "Number of replicas", parseIntOption)
    .option("--region <code>", "Region code")
    .action(async (opts) => {
      const projectId = resolveProjectId(opts.project);
      const target = opts.service || getProjectLink()?.serviceId;
      if (!target) throw new Error("No service specified or linked.");
      const svcInfo = await resolveService(projectId, target);

      const body: Record<string, unknown> = {};
      if (opts.replicas !== undefined) body.replicas = opts.replicas;
      if (opts.region) body.region = opts.region;
      if (Object.keys(body).length === 0) {
        throw new Error("Pass --replicas <n> or --region <code> (or both).");
      }

      await api.patch(`/api/apps/${svcInfo.id}/scale`, body).catch((err: any) => {
        if (err?.status === 404) {
          throw new Error("Scaling endpoint not yet implemented on the platform.");
        }
        throw err;
      });

      if (isJSONMode()) {
        printJSON({ id: svcInfo.id, ...body });
      } else {
        success(`Scaled ${chalk.bold(svcInfo.name)}`);
      }
    });

  svc
    .command("logs")
    .description("Stream logs of a service")
    .option("-s, --service <name>", "Service name or ID")
    .option("-p, --project <id>", "Project name or ID")
    .option("--build", "Show build logs instead of runtime")
    .action(async (opts) => {
      const projectId = resolveProjectId(opts.project);
      const target = opts.service || getProjectLink()?.serviceId;
      if (!target) throw new Error("No service specified or linked.");
      const svcInfo = await resolveService(projectId, target);

      const { streamSSE } = await import("../lib/api.js");

      if (opts.build) {
        const app = await api.get<{ builds?: Array<{ id: string }> }>(
          `/api/apps/${svcInfo.id}`,
        );
        if (!app.builds?.length) throw new Error("No builds found");
        info(chalk.dim(`Streaming build logs for ${svcInfo.name}...\n`));
        await streamSSE(`/api/builds/${app.builds[0].id}/logs`, (event, data) => {
          if (event === "done" || event === "error") return false;
          process.stdout.write(safeLogLine(data) + "\n");
          return true;
        });
        return;
      }

      info(chalk.dim(`Streaming logs for ${svcInfo.name}... (Ctrl+C to stop)\n`));
      await streamSSE(`/api/apps/${svcInfo.id}/logs`, (event, data) => {
        if (event === "error") return false;
        process.stdout.write(safeLogLine(data) + "\n");
        return true;
      });
    });

  // Helpers in scope of registerService
  async function linkByName(_cmd: Command, name: string) {
    const projectId = resolveProjectId(undefined);
    const svcInfo = await resolveService(projectId, name);
    updateProjectLink({ serviceId: svcInfo.id, serviceName: svcInfo.name });
    if (isJSONMode()) {
      printJSON({ serviceId: svcInfo.id, serviceName: svcInfo.name });
    } else {
      success(`Linked service ${chalk.bold(svcInfo.name)}`);
    }
  }

  async function linkInteractive(_cmd: Command) {
    const projectId = resolveProjectId(undefined);
    const data = await api.get<ServicesResponse>(
      `/api/projects/${projectId}/services`,
    );
    const services = [...(data.apps || []), ...(data.addons || [])];
    if (services.length === 0) {
      throw new Error("No services in project. Use `lizard add` first.");
    }
    if (!isTTY()) {
      throw new Error(
        "Service name required in non-interactive mode. Usage: `lizard service link <name>`",
      );
    }
    const sel = await p.select({
      message: "Select a service",
      options: services.map((s: any) => ({
        value: s.id,
        label: s.name || s.addonType,
        hint: s.status,
      })),
    });
    if (p.isCancel(sel)) process.exit(5);
    const svcInfo = services.find((s: any) => s.id === sel)!;
    updateProjectLink({ serviceId: svcInfo.id, serviceName: svcInfo.name });
    if (isJSONMode()) {
      printJSON({ serviceId: svcInfo.id, serviceName: svcInfo.name });
    } else {
      success(`Linked service ${chalk.bold(svcInfo.name)}`);
    }
  }
}

function parseIntOption(value: string): number {
  const n = parseInt(value, 10);
  if (Number.isNaN(n)) throw new Error(`Invalid number: ${value}`);
  return n;
}

function safeLogLine(data: string): string {
  try {
    const parsed = JSON.parse(data);
    if (parsed.line) return parsed.line;
    if (parsed.message) return parsed.message;
    if (typeof parsed === "string") return parsed;
    return data;
  } catch {
    return data;
  }
}
