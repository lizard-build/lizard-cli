import { APIError } from "./api.js";
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
export interface Me {
    id: string;
    username: string;
    email?: string | null;
    scoped?: boolean;
}
export interface Pending {
    sessionId: string;
    sessionSecret: string;
    expiresAt: number;
}
export type Resumed = {
    kind: "none";
} | {
    kind: "complete";
} | {
    kind: "pending";
    pending: Pending;
} | {
    kind: "expired";
};
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
/** The signed-in user, or null when this machine needs a sign-in. */
export declare function currentUser(): Promise<Me | null>;
/** Finish a session an earlier run left on disk, if the browser approved it. */
export declare function resumePending(): Promise<Resumed>;
export declare function startSession(provider?: AuthProvider): Promise<Pending>;
/**
 * What an agent needs to get the user signed in: the links and what to do
 * with them. `status` and `authUrl` are what `lizard login --json` has always
 * printed; `authUrl` without a chosen method is the old link, which opens
 * GitHub.
 */
export declare function pendingPayload(pending: Pending, methods: AuthProvider[], why: "new" | "waiting" | "expired", opts?: {
    flag?: AuthProvider;
    nextCommand?: string;
}, now?: number): {
    instruction: string;
    nextCommand?: string | undefined;
    status: "pending";
    authUrl: string;
    authUrls: Partial<Record<AuthProvider, string>>;
    expiresAt: string;
};
/**
 * The error a command fails with when nobody is signed in and nobody can be
 * asked. Its body carries the sign-in links, so an agent can hand them to the
 * user and run the command again, without a separate `lizard login`.
 */
export declare function loginRequiredError(resumed: Resumed, hadLogin: boolean): Promise<APIError>;
/**
 * Sign in at a terminal: ask the method (when stdin can answer), open the
 * browser there, wait for the approval, save the login. Throws if the link
 * expires first.
 */
export declare function signInInteractive(flag?: AuthProvider): Promise<Me>;
export {};
