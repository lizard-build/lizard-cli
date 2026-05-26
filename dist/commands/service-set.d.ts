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
 *   deploy.preDeployCommand    string
 *   deploy.healthcheckPath     string
 *   deploy.healthcheckTimeout  number (ms; flattens to healthcheckTimeoutMs)
 *   source.type                "github" | "upload" | "docker"
 *   source.repoUrl             string
 *   source.branch              string
 *   source.rootDirectory       string
 *   variables.<KEY>.value      string (supports ${{...}} references)
 *
 * Note: `variables.*` are written to per-service secrets, not the legacy
 *   `envVars` column — the `/config:apply` endpoint dropped envVars in favour
 *   of `secrets.services[<name>]`. Same runtime effect, higher precedence.
 */
export declare function registerServiceSet(svc: Command): void;
