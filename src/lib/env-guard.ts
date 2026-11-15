/**
 * Variables that change how a program starts rather than what it does: a loader to preload, code
 * a shell or runtime runs first, where commands are looked up, git config and helpers.
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
]);
const PREFIXES = ["LD_", "DYLD_", "GIT_CONFIG", "GIT_SSH", "BASH_FUNC_"];

export function isStartupEnvName(name: string): boolean {
  const n = process.platform === "win32" ? name.toUpperCase() : name;
  return EXACT.has(n) || PREFIXES.some((p) => n.startsWith(p));
}
