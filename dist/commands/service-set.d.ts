import { Command } from "commander";
/**
 * `lizard service set` — atomic patch of per-service configuration.
 *
 * Input modes (priority):
 *   1. <service> --set <path>=<value>    — positional service + repeatable --set pairs
 *   2. -f <file>                         — read JSON from file (multi-service)
 *   3. piped stdin JSON                  — auto-detected when stdin has data
 *   4. interactive                       — TTY prompts when nothing else is given
 *
 * Dot-paths supported:
 *   build.buildCommand         string
 *   build.watchPatterns        string[] (JSON array or comma-separated)
 *   build.dockerfilePath       string
 *   deploy.startCommand        string
 *   deploy.healthcheckPath     string
 *   deploy.healthcheckTimeout  number
 *   deploy.restartPolicyType   "ON_FAILURE" | "ALWAYS" | "NEVER"
 *   source.repoUrl             string
 *   source.branch              string
 *   source.rootDirectory       string
 *   variables.<KEY>.value      string (supports ${{...}} references)
 *
 * Note: replica count is changed via `lizard scale`, not here.
 */
export declare function registerServiceSet(svc: Command): void;
