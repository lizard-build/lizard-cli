import { Command } from "commander";
/**
 * `lizard service set` — atomic patch of per-service configuration.
 *
 * Three input modes (priority):
 *   1. -s <SERVICE> <DOT_PATH> <VALUE>  — repeatable Railway-style flags
 *   2. -f <file>                         — read JSON from file
 *   3. piped stdin JSON                  — auto-detected when stdin has data
 *   4. interactive                       — TTY prompts when nothing else is given
 *
 * Dot-paths supported:
 *   build.builder              "RAILPACK" | "DOCKERFILE"
 *   build.buildCommand         string
 *   build.watchPatterns        string[] (JSON array or comma-separated)
 *   build.dockerfilePath       string
 *   deploy.startCommand        string
 *   deploy.healthcheckPath     string
 *   deploy.healthcheckTimeout  number
 *   deploy.numReplicas         number
 *   deploy.restartPolicyType   "ON_FAILURE" | "ALWAYS" | "NEVER"
 *   source.repo                string
 *   source.branch              string
 *   source.image               string
 *   source.rootDirectory       string
 *   variables.<KEY>.value      string (supports ${{...}} references)
 */
export declare function registerServiceSet(svc: Command): void;
