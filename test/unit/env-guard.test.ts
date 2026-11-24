import { describe, expect, it } from "vitest";
import { isStartupEnvName } from "../../src/lib/env-guard.js";
import { writableChanges } from "../../src/commands/gha.js";

describe("lizard run: variables that change how programs start are not set locally", () => {
  it.each(["LD_PRELOAD", "LD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES", "NODE_OPTIONS", "BASH_ENV", "ENV", "PROMPT_COMMAND", "PATH",
    "PYTHONSTARTUP", "PYTHONPATH", "PERL5OPT", "RUBYOPT", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_GLOBAL", "GIT_SSH_COMMAND", "GIT_EXEC_PATH",
    "BASH_FUNC_ls%%", "GIT_EXTERNAL_DIFF", "GIT_PAGER", "GIT_EDITOR", "GIT_SEQUENCE_EDITOR", "GIT_PROXY_COMMAND", "GIT_SSH", "GIT_ASKPASS",
    "SSH_ASKPASS", "GOFLAGS", "RUSTC_WRAPPER", "RUSTC", "CARGO_BUILD_RUSTC_WRAPPER", "PYTHONWARNINGS", "JDK_JAVA_OPTIONS", "JAVA_TOOL_OPTIONS",
    "_JAVA_OPTIONS", "DOTNET_STARTUP_HOOKS", "npm_config_script_shell", "NPM_CONFIG_NODE_OPTIONS", "Npm_Config_x", "PHPRC", "PHP_INI_SCAN_DIR",
    "PAGER", "EDITOR", "VISUAL", "LESSOPEN", "LESSCLOSE", "BROWSER", "HTTPS_PROXY", "https_proxy", "http_proxy", "ALL_PROXY", "all_proxy",
    "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE"])("%s is skipped", (n) => expect(isStartupEnvName(n)).toBe(true));

  it.each(["DATABASE_URL", "NODE_ENV", "PORT", "REDIS_URL", "API_KEY", "PATHNAME", "ENVIRONMENT", "GITHUB_TOKEN", "NO_PROXY", "NPM_TOKEN", "EDITOR_THEME"])("%s is set", (n) =>
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
