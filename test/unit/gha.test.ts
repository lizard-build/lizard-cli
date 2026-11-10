import { describe, expect, it } from "vitest";
import { repoFromRemote, trialLine } from "../../src/commands/gha.js";

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

describe("trialLine", () => {
  it("shows the jobs left", () => {
    expect(trialLine({ jobs: { medium: 20, large: 10 }, jobsLeft: { medium: 18, large: 0 } }))
      .toBe("Trial: 18 of 20 medium and 0 of 10 large runner jobs left, then small runners only. Start Pro (or add credit) for unlimited.");
  });

  it("states the rule without counts (older server)", () => {
    expect(trialLine({})).toMatch(/^Trial: 20 medium and 10 large runner jobs, then small runners only/);
  });
});
