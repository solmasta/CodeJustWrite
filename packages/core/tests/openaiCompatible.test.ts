import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createOpenAICompatibleProvider, toOpenAIMessages } from "../src/providers/openaiCompatible.js";
import { ModelUnavailableError } from "../src/providers/types.js";

describe("toOpenAIMessages", () => {
  it("serializes a user message's images as multimodal content parts alongside the text", () => {
    const [message] = toOpenAIMessages([
      { role: "user", content: "what's in this screenshot?", images: ["data:image/png;base64,AAAA"] },
    ]);
    expect(message).toEqual({
      role: "user",
      content: [
        { type: "text", text: "what's in this screenshot?" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
      ],
    });
  });

  it("leaves an ordinary text-only user message as a plain string", () => {
    const [message] = toOpenAIMessages([{ role: "user", content: "hello" }]);
    expect(message).toEqual({ role: "user", content: "hello" });
  });
});

describe("createOpenAICompatibleProvider listModels", () => {
  let server: Server;
  let baseURL: string;

  beforeAll(async () => {
    // A minimal stand-in for an OpenAI-compatible /models endpoint (what
    // Ollama's local server exposes) so listModels() is exercised against a
    // real HTTP response shape without hitting the real network.
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

describe("createOpenAICompatibleProvider complete", () => {
  let server: Server;
  let baseURL: string;

  afterAll(() => {
    server?.close();
  });

  it(
    // Reproduces a real production failure: a no-arg tool call (git_status's schema has zero
    // parameters) whose streamed delta never includes an `arguments` chunk at all — some models
    // simply never emit one for an empty schema — must still come back as "{}", not "", or this
    // exact tool call breaks the *next* turn's request when it's replayed as history (the
    // provider rejects an empty-string `arguments` as invalid JSON).
    "defaults a tool call's arguments to '{}' when the model never streams any arguments chunk",
    async () => {
      server = createServer((req, res) => {
        res.setHeader("content-type", "text/event-stream");
        const chunks = [
          { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "git_status" } }] } }] },
          { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
        ];
        for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const { port } = server.address() as AddressInfo;
      baseURL = `http://127.0.0.1:${port}`;

      const provider = createOpenAICompatibleProvider({ name: "test", apiKey: "test-key", baseURL });
      const result = await provider.complete([{ role: "user", content: "status?" }], [], "test-model");

      expect(result.message.toolCalls).toEqual([{ id: "call_1", name: "git_status", arguments: "{}" }]);
      expect(() => JSON.parse(result.message.toolCalls![0].arguments)).not.toThrow();
    }
  );

  it("aborts with a clear error when a stream stalls mid-reply instead of hanging forever", async () => {
    const stalled = createServer((_req, res) => {
      res.setHeader("content-type", "text/event-stream");
      const chunk = { id: "c", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta: { content: "Hel" }, finish_reason: null }] };
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      // ...and then never another byte, never an end.
    });
    await new Promise<void>((resolve) => stalled.listen(0, "127.0.0.1", resolve));
    const { port } = stalled.address() as AddressInfo;
    try {
      const provider = createOpenAICompatibleProvider({ name: "test", apiKey: "k", baseURL: `http://127.0.0.1:${port}` });
      const deltas: string[] = [];
      await expect(
        provider.complete([{ role: "user", content: "hi" }], [], "m", {
          onTextDelta: (d) => deltas.push(d),
          idleTimeoutMs: 200,
        })
      ).rejects.toThrow(/stopped responding/);
      expect(deltas).toEqual(["Hel"]);
    } finally {
      stalled.closeAllConnections();
      stalled.close();
    }
  });

  it(
    // Reproduces the exact live failure: OpenRouter pulling a ":free" slug's free tier returns a
    // plain 404 with a message like "This model is unavailable for free. ... use this slug
    // instead: openai/gpt-oss-120b" — the agent loop needs a typed signal to tell "the model is
    // the problem" apart from any other failure, so it knows falling back to a different model is
    // actually a sane response to this one.
    "translates a 404 (model gone/unavailable-for-free) into a ModelUnavailableError",
    async () => {
      server = createServer((req, res) => {
        res.statusCode = 404;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: { message: "This model is unavailable for free." } }));
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const { port } = server.address() as AddressInfo;
      baseURL = `http://127.0.0.1:${port}`;

      const provider = createOpenAICompatibleProvider({ name: "test", apiKey: "test-key", baseURL });
      const call = provider.complete([{ role: "user", content: "hi" }], [], "some/pulled-model:free");

      await expect(call).rejects.toBeInstanceOf(ModelUnavailableError);
      await expect(call).rejects.toMatchObject({ status: 404 });
    }
  );

  it("translates a 429 (rate limited) into a ModelUnavailableError too", async () => {
    server = createServer((req, res) => {
      res.statusCode = 429;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: { message: "Rate limit exceeded" } }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    baseURL = `http://127.0.0.1:${port}`;

    const provider = createOpenAICompatibleProvider({ name: "test", apiKey: "test-key", baseURL });
    const call = provider.complete([{ role: "user", content: "hi" }], [], "some-model:free");

    await expect(call).rejects.toBeInstanceOf(ModelUnavailableError);
    await expect(call).rejects.toMatchObject({ status: 429 });
  });

  it("leaves an unrelated failure (e.g. 401) as a plain error, not a ModelUnavailableError", async () => {
    server = createServer((req, res) => {
      res.statusCode = 401;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: { message: "Invalid API key" } }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    baseURL = `http://127.0.0.1:${port}`;

    const provider = createOpenAICompatibleProvider({ name: "test", apiKey: "bad-key", baseURL });
    const call = provider.complete([{ role: "user", content: "hi" }], [], "some-model");

    // An auth failure isn't fixable by switching models — the agent loop must not treat it as one.
    await expect(call).rejects.not.toBeInstanceOf(ModelUnavailableError);
  });
});
