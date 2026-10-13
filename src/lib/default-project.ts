import chalk from "chalk";
import { api, APIError } from "./api.js";
import { info, isJSONMode } from "./format.js";

// The project a command uses when the folder is not linked and no --project is
// given: the platform's default for this account (GET /api/projects/default),
// the oldest project in the personal workspace. Every account gets one at
// sign-up, so `lizard sandbox create` or `lizard up` from any folder works
// without `lizard init` first.

export interface DefaultProject {
  id: string;
  name: string;
  slug: string;
  workspaceId: string;
  workspaceName: string;
}

let lookup: Promise<DefaultProject | null> | undefined;

/**
 * The default project, asked once per run. Null when the account has none, or
 * when the platform predates the route; callers then fail as they always did.
 * 401 still throws: that is a sign-in problem, not a missing project.
 */
export function defaultProject(): Promise<DefaultProject | null> {
  lookup ??= api.get<DefaultProject>("/api/projects/default").catch((err) => {
    if (err instanceof APIError && err.status !== 401 && err.status >= 400 && err.status < 500) return null;
    throw err;
  });
  return lookup;
}

let noted = false;

/** Say once per run which project an unlinked folder ended up in, and how to choose another. */
export function noteDefaultProject(name: string): void {
  if (noted) return;
  noted = true;
  const note = `Project: ${name} (your default). Pass --project for another, or run \`lizard init\` to link this folder.`;
  // stderr, so stdout stays pure JSON; agents read both and need to know where the command landed.
  if (isJSONMode()) process.stderr.write(note + "\n");
  else info(chalk.dim(note));
}

/** For tests: forget the cached answer. */
export function resetDefaultProject(): void {
  lookup = undefined;
  noted = false;
}
