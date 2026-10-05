import { describe, test, expect } from "vitest";
import { detectAgent } from "../../src/lib/agent.js";

describe("detectAgent", () => {
  test("nothing set means no agent", () => {
    expect(detectAgent({})).toBeNull();
  });

  test("recognises the agents by the variables they set", () => {
    expect(detectAgent({ CLAUDECODE: "1" })).toBe("claude-code");
    expect(detectAgent({ CODEX_SANDBOX: "seatbelt" })).toBe("codex");
    expect(detectAgent({ CODEX_SANDBOX_NETWORK_DISABLED: "1" })).toBe("codex");
    expect(detectAgent({ GEMINI_CLI: "1" })).toBe("gemini-cli");
    expect(detectAgent({ CURSOR_AGENT: "1" })).toBe("cursor");
    expect(detectAgent({ CURSOR_TRACE_ID: "abc" })).toBe("cursor-terminal");
  });

  test("an explicit value wins and is reduced to a slug", () => {
    expect(detectAgent({ LIZARD_AGENT: "My Harness", CLAUDECODE: "1" })).toBe("my-harness");
    expect(detectAgent({ AI_AGENT: "amp" })).toBe("amp");
    expect(detectAgent({ LIZARD_AGENT: "not/allowed" })).toBeNull();
  });

  test("an agent outranks the CI it runs in", () => {
    expect(detectAgent({ CLAUDECODE: "1", GITHUB_ACTIONS: "true", CI: "true" })).toBe("claude-code");
    expect(detectAgent({ GITHUB_ACTIONS: "true", CI: "true" })).toBe("github-actions");
    expect(detectAgent({ CI: "1" })).toBe("ci");
  });
});
