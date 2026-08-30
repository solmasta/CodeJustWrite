import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createOpenAICompatibleProvider } from "../src/providers/openaiCompatible.js";

describe("createOpenAICompatibleProvider listModels", () => {
  let server: Server;
  let baseURL: string;

  beforeAll(async () => {
    // A minimal stand-in for an OpenAI-compatible /models endpoint (what
    // DeepInfra and OpenRouter both expose) so listModels() is exercised
    // against a real HTTP response shape without hitting the real network.
    server = createServer((req, res) => {
      if (req.url === "/models") {
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            object: "list",
            data: [
              { id: "meta-llama/llama-3.1-70b-instruct", object: "model", created: 0, owned_by: "meta" },
              { id: "anthropic/claude-opus-5", object: "model", created: 0, owned_by: "anthropic" },
              { id: "anthropic/claude-sonnet-5", object: "model", created: 0, owned_by: "anthropic" },
            ],
          })
        );
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    baseURL = `http://127.0.0.1:${port}`;
  });

  afterAll(() => {
    server.close();
  });

  it("returns the provider's model catalog, sorted by id", async () => {
    const provider = createOpenAICompatibleProvider({ name: "test", apiKey: "test-key", baseURL });
    const models = await provider.listModels();
    expect(models.map((m) => m.id)).toEqual([
      "anthropic/claude-opus-5",
      "anthropic/claude-sonnet-5",
      "meta-llama/llama-3.1-70b-instruct",
    ]);
  });
});
