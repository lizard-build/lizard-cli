/**
 * Variables that change how a program starts rather than what it does: a loader to preload, code
 * a shell or runtime runs first, where commands are looked up, git config and helpers, programs
 * that tools start (pagers, editors, wrappers), proxies and trusted certificates.
 * `lizard run` puts a project's variables into a command on this machine, and anyone who can
 * edit the project's variables could set these to run code here; so they are not set locally
 * (they still apply to the service on Lizard).
 */
const EXACT = new Set([
  "NODE_OPTIONS",
  "NODE_PATH",
  "BASH_ENV",
  "ENV",
  "PROMPT_COMMAND",
  "PATH",
  "PYTHONSTARTUP",
  "PYTHONPATH",
  "PYTHONHOME",
  "PERL5OPT",
  "PERL5LIB",
  "RUBYOPT",
  "RUBYLIB",
  "GIT_EXEC_PATH",
  "GIT_ASKPASS",
  "SSH_ASKPASS",
  "SHELLOPTS",
  "BASHOPTS",
  "IFS",
  "JAVA_TOOL_OPTIONS",
  "_JAVA_OPTIONS",
  "ZDOTDIR",
  // git: programs it runs (diff, pager, editors, proxy)
  "GIT_EXTERNAL_DIFF",
  "GIT_PAGER",
  "GIT_EDITOR",
  "GIT_SEQUENCE_EDITOR",
  "GIT_PROXY_COMMAND",
  // toolchains that run a wrapper or read flags/hooks from the environment
  "GOFLAGS",
  "RUSTC_WRAPPER",
  "RUSTC",
  "CARGO_BUILD_RUSTC_WRAPPER",
  "PYTHONWARNINGS",
  "JDK_JAVA_OPTIONS",
  "DOTNET_STARTUP_HOOKS",
  "PHPRC",
  "PHP_INI_SCAN_DIR",
  // programs other programs start for you
  "PAGER",
  "EDITOR",
  "VISUAL",
  "LESSOPEN",
  "LESSCLOSE",
  "BROWSER",
  // where traffic goes and which certificates are trusted
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
]);
const PREFIXES = ["LD_", "DYLD_", "GIT_CONFIG", "GIT_SSH", "BASH_FUNC_"];
/** Matched whatever the case: tools read these in either case (npm_config_*, http_proxy). */
const ANY_CASE_EXACT = new Set(["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"]);
const ANY_CASE_PREFIXES = ["NPM_CONFIG_"];

export function isStartupEnvName(name: string): boolean {
  const n = process.platform === "win32" ? name.toUpperCase() : name;
  if (EXACT.has(n) || PREFIXES.some((p) => n.startsWith(p))) return true;
  const u = name.toUpperCase();
  return ANY_CASE_EXACT.has(u) || ANY_CASE_PREFIXES.some((p) => u.startsWith(p));
}
