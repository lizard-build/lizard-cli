import { describe, expect, it } from "vitest";
import { repoFromRemote } from "../../src/commands/gha.js";

describe("repoFromRemote", () => {
  it.each([
    ["git@github.com:acme/api.git", "acme/api"],
    ["https://github.com/acme/api.git", "acme/api"],
    ["https://github.com/acme/api", "acme/api"],
    ["ssh://git@github.com/acme/my.repo.git", "acme/my.repo"],
    ["https://x-access-token:abc@github.com/acme/api.git", "acme/api"],
  ])("%s", (url, want) => expect(repoFromRemote(url)).toBe(want));

  it("ignores other hosts", () => {
    expect(repoFromRemote("git@gitlab.com:acme/api.git")).toBeNull();
    expect(repoFromRemote("https://lizard.build/git/acme/api.git")).toBeNull();
  });
});
