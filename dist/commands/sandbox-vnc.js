import net from "node:net";
import WebSocket from "ws";
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
export function vncTarget(desktopUrl) {
    const u = new URL(desktopUrl);
    let token = u.searchParams.get("token");
    if (!token) {
        const path = u.searchParams.get("path") ?? "";
        token = new URLSearchParams(path.split("?")[1] ?? "").get("token");
    }
    const password = u.searchParams.get("password") ?? "";
    if (!token || !password)
        throw new Error("The desktop URL has no token or password; is the desktop running?");
    return { wsUrl: `wss://${u.host}/websockify?token=${encodeURIComponent(token)}`, password };
}
/** Listen on 127.0.0.1 at the first free port from `startPort` (up to +20). */
async function listenFree(server, startPort) {
    for (let port = startPort; port < startPort + 20; port++) {
        const ok = await new Promise((resolve, reject) => {
            const onError = (e) => {
                server.off("listening", onListening);
                if (e.code === "EADDRINUSE" || e.code === "EACCES")
                    resolve(false);
                else
                    reject(e);
            };
            const onListening = () => { server.off("error", onError); resolve(true); };
            server.once("error", onError);
            server.once("listening", onListening);
            server.listen(port, "127.0.0.1");
        });
        if (ok)
            return port;
    }
    throw new Error(`No free local port between ${startPort} and ${startPort + 19}; pass --port.`);
}
/** Serve the tunnel until Ctrl-C. Resolves with the port once listening; `onConnect`
 *  and `onClose` report each VNC app session. */
export async function startVncTunnel(wsUrl, startPort, events = {}) {
    const server = net.createServer((sock) => {
        sock.setNoDelay(true);
        sock.pause();
        // websockify speaks the "binary" subprotocol: frames are raw RFB bytes.
        const ws = new WebSocket(wsUrl, ["binary"], { perMessageDeflate: false });
        const end = (reason) => {
            if (!sock.destroyed)
                sock.destroy();
            if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)
                ws.terminate();
            events.onClose?.(reason);
        };
        let closed = false;
        const endOnce = (reason) => { if (!closed) {
            closed = true;
            end(reason);
        } };
        ws.on("open", () => {
            events.onConnect?.();
            sock.resume();
        });
        ws.on("message", (data) => { if (!sock.destroyed)
            sock.write(data); });
        ws.on("close", () => endOnce("the desktop closed the connection"));
        ws.on("error", (e) => endOnce(/403/.test(e.message) ? "the desktop refused the token (stopped or restarted?)" : e.message));
        sock.on("data", (chunk) => { if (ws.readyState === WebSocket.OPEN)
            ws.send(chunk, { binary: true }); });
        sock.on("close", () => endOnce("the VNC app disconnected"));
        sock.on("error", () => endOnce("the VNC app disconnected"));
    });
    const port = await listenFree(server, startPort);
    return { port, close: () => server.close() };
}
//# sourceMappingURL=sandbox-vnc.js.map