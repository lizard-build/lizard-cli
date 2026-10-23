import { describe, test, expect } from "vitest";
import { Command } from "commander";
import { registerProjects } from "../../src/commands/projects.js";

function deleteCommand(): Command {
  const program = new Command();
  registerProjects(program);
  const project = program.commands.find((c) => c.name() === "project")!;
  return project.commands.find((c) => c.name() === "delete")!;
}

describe("project delete", () => {
  test("needs the project named: no fallback to the linked folder or the default project", () => {
    const args = deleteCommand().registeredArguments;
    expect(args).toHaveLength(1);
    expect(args[0].name()).toBe("project");
    expect(args[0].required).toBe(true);
  });

  test("refuses to run without a project before calling the API", async () => {
    const program = new Command().exitOverride();
    registerProjects(program);
    program.commands.forEach((c) => c.exitOverride().commands.forEach((s) => s.exitOverride().configureOutput({ writeErr: () => {} })));
    await expect(program.parseAsync(["node", "lizard", "project", "delete", "--yes"])).rejects.toMatchObject({
      code: "commander.missingArgument",
    });
  });
});
