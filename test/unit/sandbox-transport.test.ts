import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { WebSocketServer } from "ws";
import { execStream, registerSandbox } from "../../src/commands/sandbox.js";
import { getBaseURL, setBaseURL, setAccessToken } from "../../src/lib/api.js";
import { startVncTunnel, vncTarget } from "../../src/commands/sandbox-vnc.js";
vi.mock("../../src/lib/format.js", () => ({ isJSONMode: () => true, printJSON: vi.fn() }));

const originalURL = getBaseURL();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-transport-"));
let respond: (req: http.IncomingMessage, res: http.ServerResponse) => void;
const server = http.createServer((req, res) => respond(req, res));
let base: string;
beforeAll(async () => {
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  base = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
  setBaseURL(base); setAccessToken("test-token");
});
afterAll(async () => { setBaseURL(originalURL); setAccessToken(""); await new Promise<void>(r => server.close(() => r())); fs.rmSync(tmp, { recursive: true }); });
beforeEach(() => { respond = (_req, res) => res.end(); });
function command(args: string[]) {
  const program = new Command().exitOverride().configureOutput({ writeErr: () => {} });
  registerSandbox(program);
  return program.parseAsync(["sandbox", ...args], { from: "user" });
}

describe("sandbox exec stream", () => {
  it("decodes split UTF-8, CRLF and a final exit without a newline", async () => {
    const output: [string, string][] = [];
    respond = (req, res) => {
      expect(req.headers.authorization).toBe("Bearer test-token");
      expect(req.headers["user-agent"]).toMatch(/^lizard-cli\//);
      res.setHeader("Content-Type", "text/event-stream");
      const bytes = Buffer.from('event: output\r\ndata: {"stream":"stderr",\r\ndata: "line":"привет"}\r\n\r\nevent: exit\ndata: {"exitCode":7}');
      for (let i = 0; i < bytes.length; i++) res.write(bytes.subarray(i, i + 1));
      res.end();
    };
    expect(await execStream("sb", "test", (s, l) => output.push([s, l]))).toBe(7);
    expect(output).toEqual([["stderr", "привет"]]);
  });
  it.each(["", 'event: output\ndata: {"line":"partial"}\n\n'])("rejects an incomplete stream", async body => {
    respond = (_req, res) => res.end(body);
    await expect(execStream("sb", "test", () => {})).rejects.toMatchObject({ code: "EXEC_STREAM_INCOMPLETE" });
  });
  it.each([null, -1, 256, 1.5, "0"])("rejects invalid exit code %s", async exitCode => {
    respond = (_req, res) => res.end(`event: exit\ndata: ${JSON.stringify({ exitCode })}\n\n`);
    await expect(execStream("sb", "test", () => {})).rejects.toThrow("Invalid exec exit event");
  });
  it.each([401, 403, 404, 408, 504])("preserves HTTP %i as an APIError", async status => {
    respond = (_req, res) => { res.writeHead(status); res.end(JSON.stringify({ error: "test failure", code: "TEST" })); };
    await expect(execStream("sb", "test", () => {})).rejects.toMatchObject({ status, message: "test failure", code: "TEST" });
  });
  it("accepts a complete success", async () => {
    respond = (_req, res) => res.end('event: exit\ndata: {"exitCode":0}\n\n');
    expect(await execStream("sb", "true", () => {})).toBe(0);
  });
});

describe("binary files", () => {
  it.each([Buffer.from([0, 255, 128, 13, 10, 195, 40]), Buffer.alloc(0)])("round-trips arbitrary bytes", async bytes => {
    const input = path.join(tmp, "input.bin"), output = path.join(tmp, "output.bin");
    fs.writeFileSync(input, bytes);
    let stored = Buffer.alloc(0);
    respond = (req, res) => {
      if (req.method === "POST") {
        let body = ""; req.on("data", b => body += b); req.on("end", () => {
          const data = JSON.parse(body); expect(data.encoding).toBe("base64");
          expect(data.path).toBe("/workspace/binary"); stored = Buffer.from(data.content, data.encoding);
          res.setHeader("Content-Type", "application/json"); res.end('{"status":"written"}');
        });
      } else { res.setHeader("Content-Type", "application/octet-stream"); res.end(stored); }
    };
    await command(["files", "put", "sb", input, "/workspace/binary"]);
    await command(["files", "get", "sb", "/workspace/binary", output]);
    expect(fs.readFileSync(output)).toEqual(bytes);
  });
});

describe("ports", () => {
  it.each(["3000oops", "3.5", "0", "65536", "-1"])("rejects %s before a request", async port => {
    let requests = 0; respond = (_req, res) => { requests++; res.end('{}'); };
    await expect(command(["vnc", "sb", "--port", port])).rejects.toThrow(/Port must be/);
    expect(requests).toBe(0);
  });
});

describe("private VNC tunnel", () => {
  it.each(["control", "view"])("forwards both tokens for %s sessions", async token => {
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1", verifyClient: info => info.req.headers["x-lizard-access-token"] === "private" });
    await once(wss, "listening");
    const port = (wss.address() as net.AddressInfo).port;
    const target = vncTarget(`http://127.0.0.1:${port}/stream.html?token=${token}&password=pw&lizard_token=private`);
    let upstreamPath = "";
    wss.on("connection", (ws, req) => { upstreamPath = req.url!; ws.send(Buffer.from("RFB 003.008\n")); });
    const tunnel = await startVncTunnel(target.wsUrl, 19590, {}, target.headers);
    const sock = net.connect(tunnel.port, "127.0.0.1");
    try {
      const [bytes] = await once(sock, "data");
      expect(bytes.toString()).toBe("RFB 003.008\n");
      expect(upstreamPath).toBe(`/websockify?token=${token}`);
    } finally { sock.destroy(); tunnel.close(); for (const ws of wss.clients) ws.terminate(); await new Promise<void>(r => wss.close(() => r())); }
  });
  it("supports older noVNC URLs", () => {
    expect(vncTarget("https://desktop/vnc.html?path=websockify%3Ftoken%3Da%252Bb&password=pw")).toEqual({ wsUrl: "wss://desktop/websockify?token=a%2Bb", password: "pw", headers: {} });
  });
});
