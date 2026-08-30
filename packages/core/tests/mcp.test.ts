import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { connectMcpServers } from "../src/mcp/connect.js";
import { makeCtx } from "./testUtils.js";

describe("connectMcpServers", () => {
  let httpServer: Server;
  let baseUrl: string;
  const VALID_KEY = "test-static-key";

  beforeAll(async () => {
    // A minimal real MCP server (not a mock of our own client code) exposing one
    // confirmation-required tool and one read-only tool, reachable over HTTP with a
    // static bearer token — the same shape a real static-key connector would take.
    const mcpServer = new McpServer({ name: "test-mcp-server", version: "1.0.0" });

    mcpServer.registerTool(
      "echo",
      { description: "Echoes the given text back.", inputSchema: { text: z.string() } },
      async ({ text }) => ({ content: [{ type: "text" as const, text: `echo: ${text}` }] })
    );

    mcpServer.registerTool(
      "whoami",
      { description: "Read-only info tool.", annotations: { readOnlyHint: true } },
      async () => ({ content: [{ type: "text" as const, text: "test-mcp-server" }] })
    );

    // Stateful mode (a real sessionIdGenerator): the SDK's stateless mode has a bug in this
    // version where the client's post-initialize "notifications/initialized" message gets a
    // bare 500 back, which isn't something our connect.ts can work around — real MCP servers
    // typically run stateful anyway (the SDK's own docs default to it).
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
    await mcpServer.connect(transport);

    httpServer = createServer((req, res) => {
      if (req.headers.authorization !== `Bearer ${VALID_KEY}`) {
        res.statusCode = 401;
        res.end("unauthorized");
        return;
      }
      void transport.handleRequest(req, res);
    });
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const { port } = httpServer.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}/mcp`;
  });

  afterAll(() => {
    httpServer.close();
  });

  it("connects, exposes namespaced tools, and honors readOnlyHint for confirmation", async () => {
    const conns = await connectMcpServers([{ name: "test", transport: "http", url: baseUrl, apiKey: VALID_KEY }]);

    expect(conns.statuses).toEqual([{ name: "test", connected: true, toolCount: 2 }]);
    expect(conns.tools.map((t) => t.spec.name).sort()).toEqual(["mcp_test_echo", "mcp_test_whoami"]);

    const echoTool = conns.tools.find((t) => t.spec.name === "mcp_test_echo")!;
    const whoamiTool = conns.tools.find((t) => t.spec.name === "mcp_test_whoami")!;
    expect(echoTool.requiresConfirmation).toBe(true);
    expect(whoamiTool.requiresConfirmation).toBe(false);

    const result = await echoTool.run({ text: "hi" }, makeCtx("/tmp"));
    expect(result).toBe("echo: hi");

    await conns.close();
  });

  it("reports a failed connection instead of throwing when the API key is wrong", async () => {
    const conns = await connectMcpServers([{ name: "test", transport: "http", url: baseUrl, apiKey: "wrong-key" }]);

    expect(conns.tools).toEqual([]);
    expect(conns.statuses).toHaveLength(1);
    expect(conns.statuses[0]).toMatchObject({ name: "test", connected: false, toolCount: 0 });
    expect(conns.statuses[0].error).toBeTruthy();
  });

  it("is a no-op with no servers configured", async () => {
    const conns = await connectMcpServers([]);
    expect(conns.tools).toEqual([]);
    expect(conns.statuses).toEqual([]);
    await conns.close();
  });
});
