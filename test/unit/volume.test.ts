import { expect, it, vi } from "vitest";
import { Command } from "commander";
import { registerVolume } from "../../src/commands/volume.js";
import { api } from "../../src/lib/api.js";

vi.mock("../../src/lib/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/api.js")>();
  return { ...actual, api: { get: vi.fn(), patch: vi.fn() } };
});

it("rejects the removed resize command without making API requests", async () => {
  const program = new Command().exitOverride().configureOutput({ writeErr: () => {} });
  registerVolume(program);
  const volume = program.commands.find(command => command.name() === "volume")!;
  expect(volume.commands.flatMap(command => [command.name(), ...command.aliases()])).not.toContain("resize");
  await expect(program.parseAsync(["volume", "resize", "build-cache", "--size", "10"], { from: "user" }))
    .rejects.toMatchObject({ code: "commander.unknownCommand" });
  expect(api.get).not.toHaveBeenCalled();
  expect(api.patch).not.toHaveBeenCalled();
});
