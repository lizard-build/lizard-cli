import { type Credentials, type PendingAuth } from "./config.js";
export type { Credentials } from "./config.js";
/**
 * The env var carrying a token or a `liz_` API key. LIZARD_TOKEN is the
 * original name; LIZARD_API_KEY is what people reach for when what they hold
 * is an API key, and it silently did nothing before — the CLI fell through to
 * the credentials file and reported "Not authenticated" while the key sat
 * right there in the environment. Both names go to the same header.
 */
export declare function envToken(): string | null;
/** Get the active token in priority order: env → file */
export declare function getToken(): string | null;
export declare function loadCredentials(): Credentials | null;
export declare function saveCredentials(creds: Credentials): void;
export declare function clearCredentials(): void;
export declare function loadPendingAuth(): PendingAuth | null;
export declare function savePendingAuth(pending: PendingAuth): void;
export declare function clearPendingAuth(): void;
export declare function isLoggedIn(): boolean;
/** The token a command would use right now, or null when a sign-in is needed. */
export declare function validToken(): string | null;
/** Store what an approved CLI session returned, and drop the pending session. */
export declare function saveSessionLogin(result: {
    accessToken: string;
    user: {
        id: string;
        username: string;
        email?: string;
        avatarUrl?: string;
    };
}): Credentials;
/**
 * Expiry of a JWT in epoch-ms, decoded from the `exp` claim. Returns null
 * for opaque/undecodable tokens — those are treated as valid and left for
 * the server to reject.
 */
export declare function jwtExpiryMs(token: string): number | null;
/**
 * Ensure the user is authenticated.
 *
 * A token from the environment or a saved login that has not expired wins.
 * Otherwise a session the browser already approved finishes here. Failing
 * that, a person at a terminal signs in on the spot (pick GitHub or Google,
 * the browser opens, the CLI waits) and the command carries on. Anything else
 * (an agent, a pipe, --json) gets a NOT_AUTHENTICATED error whose body holds
 * the sign-in links; once the user approves, the same command run again
 * picks the session up.
 */
export declare function requireAuth(): Promise<Credentials>;
/** Open a URL in the default browser, or print it if headless. */
export declare function openURL(url: string): Promise<boolean>;
