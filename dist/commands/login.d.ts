import { Command } from "commander";
/** The sign-in methods the /auth/cli page can send a person to. */
export type AuthProvider = "github" | "google";
export declare const AUTH_PROVIDERS: AuthProvider[];
interface SessionResponse {
    sessionId: string;
    sessionSecret: string;
    expiresIn: number;
}
export interface CheckResponse {
    status: "pending" | "complete" | "expired";
    accessToken?: string;
    user?: {
        id: string;
        username: string;
        email?: string;
        avatarUrl?: string;
    };
}
/**
 * The page that approves a CLI session. With a provider it signs a signed-out
 * browser in with that method; without one it uses GitHub, as it always has.
 */
export declare function authUrlFor(sessionId: string, provider?: AuthProvider): string;
/** Which sign-in methods the platform offers. Both, if it cannot be asked. */
export declare function fetchAuthProviders(): Promise<AuthProvider[]>;
/** `--github` / `--google`, or undefined when neither is given. */
export declare function providerFlag(opts: {
    github?: boolean;
    google?: boolean;
}): AuthProvider | undefined;
/** Create a CLI login session on the server */
export declare function createSession(): Promise<SessionResponse>;
/** Check once if the user has completed authentication (no polling loop) */
export declare function checkSession(sessionId: string, sessionSecret: string): Promise<CheckResponse>;
/**
 * Start the login flow: creates a session, saves it to disk, surfaces the
 * auth URL, then exits. In human mode it opens the browser and prints the
 * URL; in JSON mode it emits the URL as JSON and never opens a browser. The
 * user authenticates and re-runs their original command — requireAuth will
 * pick up the pending session.
 */
export declare function performLogin(provider?: AuthProvider): Promise<never>;
export declare function registerLogin(program: Command): void;
export {};
