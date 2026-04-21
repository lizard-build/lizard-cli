import { Command } from "commander";
import { type Credentials } from "../lib/auth.js";
/**
 * Perform the login flow. Used by the login command and by auto-login in requireAuth.
 */
export declare function performLogin(): Promise<Credentials>;
export declare function registerLogin(program: Command): void;
