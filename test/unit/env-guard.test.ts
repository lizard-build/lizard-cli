import { describe, expect, it } from "vitest";
import { isStartupEnvName } from "../../src/lib/env-guard.js";
import { writableChanges } from "../../src/commands/gha.js";

describe("lizard run: variables that change how programs start are not set locally", () => {
  it.each(["LD_PRELOAD", "LD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES", "NODE_OPTIONS", "BASH_ENV", "ENV", "PROMPT_COMMAND", "PATH",
    "PYTHONSTARTUP", "PYTHONPATH", "PERL5OPT", "RUBYOPT", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_GLOBAL", "GIT_SSH_COMMAND", "GIT_EXEC_PATH",
    "BASH_FUNC_ls%%"])("%s is skipped", (n) => expect(isStartupEnvName(n)).toBe(true));

  it.each(["DATABASE_URL", "NODE_ENV", "PORT", "REDIS_URL", "API_KEY", "PATHNAME", "ENVIRONMENT", "GITHUB_TOKEN"])("%s is set", (n) =>
    expect(isStartupEnvName(n)).toBe(false));
});

describe("lizard gha migrate writes only files it sent", () => {
  it("drops paths the server made up", () => {
    const sent = [{ path: ".github/workflows/ci.yml" }];
    const r = writableChanges(sent, [
      { path: ".github/workflows/ci.yml", changed: true, text: "a" },
      { path: "../../.bashrc", changed: true, text: "evil" },
      { path: ".github/workflows/other.yml", changed: true, text: "b" },
      { path: ".github/workflows/ci.yml/../../../x", changed: true, text: "c" },
    ]);
    expect(r.changed.map((f) => f.path)).toEqual([".github/workflows/ci.yml"]);
    expect(r.foreign).toEqual(["../../.bashrc", ".github/workflows/other.yml", ".github/workflows/ci.yml/../../../x"]);
  });
});
