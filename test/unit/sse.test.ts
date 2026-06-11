import { describe, test, expect, beforeEach, afterEach } from "vitest";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { streamSSE, setBaseURL, getBaseURL, APIError } from "../../src/lib/api.js";

type SSEHandler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

let server: http.Server;
let serveSSE: SSEHandler;
const originalBaseURL = getBaseURL();

beforeEach(async () => {
  server = http.createServer((req, res) => serveSSE(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  setBaseURL(`http://127.0.0.1:${port}`);
});

afterEach(async () => {
  setBaseURL(originalBaseURL);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function sseHead(res: http.ServerResponse) {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
}

describe("streamSSE parsing", () => {
  test("dispatches events and stops when handler returns false", async () => {
    serveSSE = (_req, res) => {
      sseHead(res);
      res.write("data: one\n\n");
      res.write("data: two\n\n");
      res.write("event: done\ndata: bye\n\n");
      // Keep the connection open — the handler's `false` must end the stream.
    };

    const seen: Array<[string, string]> = [];
    await streamSSE("/sse", (event, data) => {
      seen.push([event, data]);
      return event !== "done";
    });
    expect(seen).toEqual([["", "one"], ["", "two"], ["done", "bye"]]);
  });

  test("concatenates multiple data: lines with newlines (SSE spec)", async () => {
    serveSSE = (_req, res) => {
      sseHead(res);
      res.write("data: line1\ndata: line2\n\n");
      res.end();
    };

    const seen: string[] = [];
    await streamSSE("/sse", (_event, data) => {
      seen.push(data);
      return true;
    });
    expect(seen).toEqual(["line1\nline2"]);
  });

  test("ignores heartbeat comments and empty data", async () => {
    serveSSE = (_req, res) => {
      sseHead(res);
      res.write(": keepalive\n\n");
      res.write("data: real\n\n");
      res.end();
    };

    const seen: string[] = [];
    await streamSSE("/sse", (_event, data) => {
      seen.push(data);
      return true;
    });
    expect(seen).toEqual(["real"]);
  });

  test("rejects with APIError on HTTP >= 400", async () => {
    serveSSE = (_req, res) => {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end('{"error":"App not found"}');
    };

    await expect(streamSSE("/sse", () => true)).rejects.toSatisfy(
      (err: unknown) => err instanceof APIError && err.status === 404,
    );
  });

  test("idleTimeoutMs resolves when no events arrive", async () => {
    serveSSE = (_req, res) => {
      sseHead(res);
      res.write("data: snapshot\n\n");
      // Then go quiet without ending — idle timeout must fire.
    };

    const seen: string[] = [];
    await streamSSE(
      "/sse",
      (_event, data) => {
        seen.push(data);
        return true;
      },
      { idleTimeoutMs: 200 },
    );
    expect(seen).toEqual(["snapshot"]);
  });
});

describe("streamSSE reconnect", () => {
  test("without reconnect, server end resolves silently", async () => {
    serveSSE = (_req, res) => {
      sseHead(res);
      res.write("data: only\n\n");
      res.end();
    };
    const seen: string[] = [];
    await streamSSE("/sse", (_e, d) => (seen.push(d), true));
    expect(seen).toEqual(["only"]);
  });

  test("reconnects after drop, sends Last-Event-ID, suppresses replayed ids", async () => {
    let conn = 0;
    let lastEventIdHeader: string | undefined;
    serveSSE = (req, res) => {
      conn++;
      sseHead(res);
      if (conn === 1) {
        res.write("id: 100-0\ndata: a\n\n");
        res.write("id: 200-0\ndata: b\n\n");
        res.end(); // unexpected drop
      } else {
        lastEventIdHeader = req.headers["last-event-id"] as string | undefined;
        // Server replays history (like /api/apps/:id/logs does) + one new event
        res.write("id: 100-0\ndata: a\n\n");
        res.write("id: 200-0\ndata: b\n\n");
        res.write("id: 300-0\ndata: c\n\n");
        res.write("event: done\ndata: end\n\n");
      }
    };

    const seen: string[] = [];
    const retries: number[] = [];
    await streamSSE(
      "/sse",
      (event, data) => {
        if (event === "done") return false;
        seen.push(data);
        return true;
      },
      { reconnect: true, reconnectBaseDelayMs: 10, onReconnect: (n) => retries.push(n) },
    );

    expect(retries).toEqual([1]);
    expect(lastEventIdHeader).toBe("200-0");
    expect(seen).toEqual(["a", "b", "c"]); // no duplicate a/b after reconnect
  });

  test("rejects after exhausting reconnect attempts", async () => {
    serveSSE = (_req, res) => {
      sseHead(res);
      res.end(); // drop immediately, every time
    };

    const retries: number[] = [];
    await expect(
      streamSSE("/sse", () => true, {
        reconnect: true,
        reconnectBaseDelayMs: 10,
        onReconnect: (n) => retries.push(n),
      }),
    ).rejects.toThrow(/disconnected/);
    expect(retries).toEqual([1, 2, 3, 4, 5]);
  });
});
