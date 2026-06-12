import { type Credentials, type PendingAuth } from "./config.js";
export type { Credentials } from "./config.js";
/** Get the active token in priority order: env → file */
export declare function getToken(): string | null;
export declare function loadCredentials(): Credentials | null;
export declare function saveCredentials(creds: Credentials): void;
export declare function clearCredentials(): void;
export declare function loadPendingAuth(): PendingAuth | null;
export declare function savePendingAuth(pending: PendingAuth): void;
export declare function clearPendingAuth(): void;
export declare function isLoggedIn(): boolean;
/**
 * Expiry of a JWT in epoch-ms, decoded from the `exp` claim. Returns null
 * for opaque/undecodable tokens — those are treated as valid and left for
 * the server to reject.
 */
export declare function jwtExpiryMs(token: string): number | null;
/**
 * Ensure the user is authenticated.
 *
 * On first call with no credentials: creates a CLI auth session, saves it to
 * disk, opens the browser, prints the URL, and exits. The user authenticates
 * in the browser, then re-runs their command.
 *
 * On subsequent calls while a session is pending: checks once (no loop) if
 * the user has completed authentication. If yes, stores credentials and
 * returns them. If still pending, prints the URL and exits. If the session
 * expired, starts a fresh one.
 */
export declare function requireAuth(): Promise<Credentials>;
/** Open a URL in the default browser, or print it if headless. */
export declare function openURL(url: string): Promise<boolean>;
