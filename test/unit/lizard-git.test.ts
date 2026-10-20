import { describe, it, expect, afterEach, vi } from "vitest";
import { repoFromRemote, qs, gitURL, helperCommand, resolveRepo, lg } from "../../src/lib/lizard-git.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("lizard git helpers", () => {
  it("reads owner/name from Lizard Git remotes only", () => {
    expect(repoFromRemote("https://git.lizard.build/alice/app.git")).toBe("alice/app");
    expect(repoFromRemote("https://lizard:liz_x@git.lizard.build/alice/app")).toBe("alice/app");
    expect(repoFromRemote("https://github.com/alice/app.git")).toBeNull();
    expect(repoFromRemote("git@github.com:alice/app.git")).toBeNull();
  });

  it("drops empty query values", () => {
    expect(qs("/x", { a: "1", b: undefined, c: "", d: false, e: 2 })).toBe("/x?a=1&e=2");
  });

  it("honours LIZARD_GIT_URL", () => {
    vi.stubEnv("LIZARD_GIT_URL", "http://localhost:8080/");
    expect(gitURL()).toBe("http://localhost:8080");
    expect(repoFromRemote("http://localhost:8080/a/b.git", gitURL())).toBe("a/b");
  });

  it("runs itself as git's credential helper", () => {
    expect(helperCommand()).toMatch(/^!'.+' .*git credential$/);
  });

  it("takes owner/name or a bare name (yours) for --repo", async () => {
    vi.stubEnv("LIZARD_TOKEN", "liz_test");
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: any) => {
      calls.push(`${init.method} ${url} ${init.headers.Authorization}`);
      return new Response(JSON.stringify({ login: "me" }), { status: 200 });
    }));
    expect(await resolveRepo("alice/app")).toBe("alice/app");
    expect(await resolveRepo("app")).toBe("me/app");
    expect(calls).toEqual(["GET https://git.lizard.build/api/session Bearer liz_test"]);
    await expect(resolveRepo("a/b/c")).rejects.toThrow(/owner\/name/);
  });

  it("turns error bodies into APIError with the server's message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "no such repository" }), { status: 404 })));
    await expect(lg.get("/api/repos/a/b")).rejects.toMatchObject({ status: 404, message: "no such repository" });
  });
});
