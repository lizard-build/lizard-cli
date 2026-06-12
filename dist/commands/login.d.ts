import { Command } from "commander";
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
/** Create a CLI login session on the server */
export declare function createSession(): Promise<SessionResponse>;
/** Check once if the user has completed authentication (no polling loop) */
export declare function checkSession(sessionId: string, sessionSecret: string): Promise<CheckResponse>;
/**
 * Start the login flow: creates a session, saves it to disk, opens the
 * browser, prints the URL, then exits. The user authenticates in the browser
 * and re-runs their original command — requireAuth will pick up the session.
 */
export declare function performLogin(): Promise<never>;
export declare function registerLogin(program: Command): void;
export {};
