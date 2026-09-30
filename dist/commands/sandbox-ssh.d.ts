/**
 * `lizard sandbox ssh <id>` — an interactive shell in a running sandbox.
 *
 * Not the SSH protocol: it opens the same terminal the dashboard uses
 * (wss://…/api/sandboxes/terminal), which the platform bridges onto an exec into the
 * sandbox's pod with a TTY. So there are no keys to set up and nothing to open — the
 * CLI's own API key is the credential, and a workspace- or project-scoped key only
 * reaches sandboxes in its scope.
 *
 * Wire protocol (server/src/routes/ws.ts): binary frames are raw terminal bytes both
 * ways; a text frame {"type":"resize","cols":N,"rows":M} resizes the remote TTY.
 */
export declare function sandboxShell(id: string): Promise<number>;
