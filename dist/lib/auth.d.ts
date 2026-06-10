import { type Credentials } from "./config.js";
export type { Credentials } from "./config.js";
/** Get the active token in priority order: env → file */
export declare function getToken(): string | null;
export declare function loadCredentials(): Credentials | null;
export declare function saveCredentials(creds: Credentials): void;
export declare function clearCredentials(): void;
export declare function isLoggedIn(): boolean;
/**
 * Expiry of a JWT in epoch-ms, decoded from the `exp` claim. Returns null
 * for opaque/undecodable tokens — those are treated as valid and left for
 * the server to reject.
 */
export declare function jwtExpiryMs(token: string): number | null;
/**
 * Ensure the user is authenticated. If not logged in (or the saved token
 * has expired — there is no refresh endpoint) and TTY, auto-login.
 * Returns credentials or throws.
 */
export declare function requireAuth(): Promise<Credentials>;
/** Open a URL in the default browser, or print it if headless. */
export declare function openURL(url: string): Promise<boolean>;
