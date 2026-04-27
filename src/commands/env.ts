import { Command } from "commander";
import { api } from "../lib/api.js";
import { resolveProjectId } from "../lib/config.js";
import { success, isJSONMode, printJSON, table, info } from "../lib/format.js";

interface Environment {
  id: string;
  name: string;
  projectId: string;
  createdAt: number;
  updatedAt: number;
}

export function registerEnv(program: Command) {
  const env = program
    .command("env")
    .description("Manage environments within a project");

  env
    .command("list")
    .description("List environments in the project")
    .action(async () => {
      const projectId = resolveProjectId(program.opts().project);
      const envs = await api.get<Environment[]>(`/api/projects/${projectId}/environments`);

      if (isJSONMode()) {
        printJSON(envs);
        return;
      }

      if (envs.length === 0) {
        info(`No environments. Use \`lizard env create <name>\` to add one.`);
        return;
      }

      table(
        ["ID", "Name"],
        envs.map((e) => [e.id, e.name]),
      );
    });

  env
    .command("create")
    .argument("<name>", "Environment name")
    .description("Create a new environment")
    .option("--from <envId>", "Copy env vars from an existing environment")
    .action(async (name: string, opts) => {
      const projectId = resolveProjectId(program.opts().project);
      const body: { name: string; sourceEnvironmentId?: string } = { name };
      if (opts.from) body.sourceEnvironmentId = opts.from;

      const created = await api.post<Environment>(`/api/projects/${projectId}/environments`, body);

      if (isJSONMode()) {
        printJSON(created);
        return;
      }

      success(`Environment "${created.name}" created (${created.id})`);
    });

  env
    .command("delete")
    .argument("<id>", "Environment ID")
    .description("Delete an environment")
    .action(async (id: string) => {
      await api.delete(`/api/environments/${id}`);

      if (isJSONMode()) {
        printJSON({ ok: true, id });
        return;
      }

      success(`Environment ${id} deleted`);
    });
}
