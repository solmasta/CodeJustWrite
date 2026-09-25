import { describe, it, expect } from "vitest";
import { createServer, type Server, type RequestListener } from "node:http";
import { waitForHealth, ServerStartError } from "../src/serverProcess.js";

function listen(handler: RequestListener): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

describe("waitForHealth", () => {
  it("resolves as soon as /api/health answers 200", async () => {
    const { server, url } = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
    });
    try {
      await expect(waitForHealth(url, 2000)).resolves.toBeUndefined();
    } finally {
      server.close();
    }
  });

  it("keeps polling through failures until the server comes up", async () => {
    let attempts = 0;
    const { server, url } = await listen((_req, res) => {
      attempts++;
      if (attempts < 2) {
        res.writeHead(500);
        res.end();
        return;
      }
      res.writeHead(200);
      res.end("{}");
    });
    try {
      await waitForHealth(url, 3000);
      expect(attempts).toBeGreaterThanOrEqual(2);
    } finally {
      server.close();
    }
  });

  it("throws ServerStartError once the timeout elapses with nothing listening", async () => {
    // Nothing is bound to this port, so every attempt fails fast with a connection error.
    await expect(waitForHealth("http://127.0.0.1:1", 500)).rejects.toBeInstanceOf(ServerStartError);
  });
});
