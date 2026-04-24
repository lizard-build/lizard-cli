import { type Credentials } from "./config.js";
export type { Credentials } from "./config.js";
export declare function setTokenOverride(token: string): void;
/** Get the active token in priority order: override → env → file */
export declare function getToken(): string | null;
export declare function loadCredentials(): Credentials | null;
export declare function saveCredentials(creds: Credentials): void;
export declare function clearCredentials(): void;
export declare function isLoggedIn(): boolean;
/**
 * Ensure the user is authenticated. If not logged in and TTY, auto-login.
 * Returns credentials or throws.
 */
export declare function requireAuth(): Promise<Credentials>;
/** Open a URL in the default browser, or print it if headless. */
export declare function openURL(url: string): Promise<boolean>;
