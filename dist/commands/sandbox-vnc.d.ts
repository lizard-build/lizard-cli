/**
 * `lizard sandbox vnc <id>` — reach a desktop sandbox from a native VNC app
 * (macOS Screen Sharing, TigerVNC, RealVNC, Remmina).
 *
 * The desktop has no public VNC port: its VNC server (x11vnc) only listens inside the
 * sandbox, behind websockify on the desktop's HTTPS hostname, which accepts a WebSocket
 * at /websockify?token=… carrying the raw VNC (RFB) stream. This command listens on a
 * local TCP port and pipes each connection through such a WebSocket, so a VNC app
 * pointed at localhost talks to the sandbox's VNC server as if it were local. The VNC
 * password still applies; the view-only password gets a watch-only session, enforced
 * by x11vnc.
 */
/** The VNC WebSocket URL and password, from a desktop URL the API returned. Handles
 *  both viewer generations: stream.html/lizard.html take `token` directly; the oldest
 *  (noVNC's vnc.html) carries it inside `path=websockify?token=…`. */
export declare function vncTarget(desktopUrl: string): {
    wsUrl: string;
    password: string;
    headers: Record<string, string>;
};
/** Serve the tunnel until Ctrl-C. Resolves with the port once listening; `onConnect`
 *  and `onClose` report each VNC app session. */
export declare function startVncTunnel(wsUrl: string, startPort: number, events?: {
    onConnect?: () => void;
    onClose?: (reason: string) => void;
}, headers?: Record<string, string>): Promise<{
    port: number;
    close: () => void;
}>;
