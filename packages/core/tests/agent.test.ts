import { describe, it, expect } from "vitest";
import { Agent } from "../src/agent/agent.js";
import type { ChatMessage, CompletionResult, LLMProvider, ModelInfo, StreamHandlers, ToolSpec } from "../src/providers/types.js";
import type { ToolContext, ToolDefinition } from "../src/agent/tools/types.js";

class ScriptedProvider implements LLMProvider {
  readonly name = "scripted";
  calls = 0;
  receivedMessages: ChatMessage[][] = [];
  constructor(private readonly responses: CompletionResult[]) {}

  async complete(
    messages: ChatMessage[],
    _tools: ToolSpec[],
    _model: string,
    _handlers?: StreamHandlers
  ): Promise<CompletionResult> {
    // Snapshot the array shape at call time — `messages` is the Agent's own history array
    // passed by reference, and setSystemPrompt() replaces (not mutates) history[0], so a
    // shallow copy here is enough to keep each call's system message from appearing to
    // retroactively change once a later setSystemPrompt() call replaces that slot.
    this.receivedMessages.push([...messages]);
    const response = this.responses[this.calls];
    this.calls++;
    if (!response) throw new Error("ScriptedProvider ran out of scripted responses");
    return response;
  }

  async listModels(): Promise<ModelInfo[]> {
    return [];
  }
}

function makeCtx(): ToolContext {
  return {
    repoRoot: "/tmp",
    config: { provider: "deepinfra", model: "x", shellTimeoutSec: 30, mcpServers: [] },
    confirm: async () => true,
    log: () => {},
  };
}

describe("Agent recovering a fake (text-only) tool call", () => {
  it("executes the tool the model hallucinated instead of surfacing the raw JSON as the answer", async () => {
    let toolInvocations = 0;
    const listDirTool: ToolDefinition = {
      spec: { name: "list_dir", description: "list", parameters: { type: "object", properties: {} } },
      async run(args) {
        toolInvocations++;
        return `dirs: src, tests (path=${args.path})`;
      },
    };

    const provider = new ScriptedProvider([
      {
        message: { role: "assistant", content: '{"type": "function", "name": "list_dir", "parameters": {"path": "."}}' },
        finishReason: "stop",
      },
      {
        message: { role: "assistant", content: "The repo has src/ and tests/." },
        finishReason: "stop",
      },
    ]);

    const toolCallEvents: Array<{ name: string; args: Record<string, unknown> }> = [];
    const toolResultEvents: Array<{ name: string; result: string; error: boolean }> = [];

    const agent = new Agent({
      getProvider: () => provider,
      getModel: () => "test-model",
      ctx: makeCtx(),
      tools: [listDirTool],
      onToolCall: (name, args) => toolCallEvents.push({ name, args }),
      onToolResult: (name, result, error) => toolResultEvents.push({ name, result, error }),
    });

    const finalText = await agent.send("please review the repo");

    expect(finalText).toBe("The repo has src/ and tests/.");
    expect(toolInvocations).toBe(1);
    expect(toolCallEvents).toEqual([{ name: "list_dir", args: { path: "." } }]);
    expect(toolResultEvents).toEqual([{ name: "list_dir", result: "dirs: src, tests (path=.)", error: false }]);

    const history = agent.getHistory();
    const toolMessage = history.find((m) => m.role === "tool");
    expect(toolMessage?.content).toBe("dirs: src, tests (path=.)");
    const assistantMessage = history.find((m) => m.role === "assistant" && m.toolCalls?.length);
    expect(assistantMessage?.toolCalls?.[0]?.id).toBe(toolMessage?.toolCallId);
  });

  it("still surfaces a genuine text answer unchanged when nothing looks like a tool call", async () => {
    const provider = new ScriptedProvider([
      { message: { role: "assistant", content: "Nothing to report." }, finishReason: "stop" },
    ]);
    const agent = new Agent({
      getProvider: () => provider,
      getModel: () => "test-model",
      ctx: makeCtx(),
      tools: [],
    });

    const finalText = await agent.send("status?");
    expect(finalText).toBe("Nothing to report.");
    expect(provider.calls).toBe(1);
  });
});

describe("Agent showing a tool's image result to the model", () => {
  it("pushes a follow-up user message carrying the image(s) after the tool-role result", async () => {
    const screenshotTool: ToolDefinition = {
      spec: { name: "browser_check", description: "check", parameters: { type: "object", properties: {} } },
      async run() {
        return { text: "Loaded page.", images: ["data:image/png;base64,AAAA"] };
      },
    };

    const provider = new ScriptedProvider([
      {
        message: {
          role: "assistant",
          content: null,
          toolCalls: [{ id: "call1", name: "browser_check", arguments: "{}" }],
        },
        finishReason: "tool_calls",
      },
      { message: { role: "assistant", content: "Looks good." }, finishReason: "stop" },
    ]);

    const agent = new Agent({
      getProvider: () => provider,
      getModel: () => "test-model",
      ctx: makeCtx(),
      tools: [screenshotTool],
    });

    await agent.send("check the homepage");

    const history = agent.getHistory();
    const toolIndex = history.findIndex((m) => m.role === "tool");
    expect(history[toolIndex]?.content).toBe("Loaded page.");
    const followUp = history[toolIndex + 1];
    expect(followUp?.role).toBe("user");
    expect(followUp?.images).toEqual(["data:image/png;base64,AAAA"]);
  });

  it("doesn't add a follow-up message for a plain string tool result", async () => {
    const textTool: ToolDefinition = {
      spec: { name: "list_dir", description: "list", parameters: { type: "object", properties: {} } },
      async run() {
        return "src, tests";
      },
    };

    const provider = new ScriptedProvider([
      {
        message: {
          role: "assistant",
          content: null,
          toolCalls: [{ id: "call1", name: "list_dir", arguments: "{}" }],
        },
        finishReason: "tool_calls",
      },
      { message: { role: "assistant", content: "Done." }, finishReason: "stop" },
    ]);

    const agent = new Agent({
      getProvider: () => provider,
      getModel: () => "test-model",
      ctx: makeCtx(),
      tools: [textTool],
    });

    await agent.send("list the repo");

    const history = agent.getHistory();
    const toolIndex = history.findIndex((m) => m.role === "tool");
    expect(history[toolIndex + 1]?.role).not.toBe("user");
  });
});

describe("Agent.setSystemPrompt", () => {
  it("takes effect on the next send() without discarding the conversation so far", async () => {
    const provider = new ScriptedProvider([
      { message: { role: "assistant", content: "First reply." }, finishReason: "stop" },
      { message: { role: "assistant", content: "Second reply." }, finishReason: "stop" },
    ]);
    const agent = new Agent({
      getProvider: () => provider,
      getModel: () => "test-model",
      ctx: makeCtx(),
      tools: [],
      systemPrompt: "Initial prompt.",
    });

    await agent.send("hello");
    agent.setSystemPrompt("Updated prompt.");
    await agent.send("still here?");

    expect(provider.receivedMessages[0][0]).toEqual({ role: "system", content: "Initial prompt." });
    expect(provider.receivedMessages[1][0]).toEqual({ role: "system", content: "Updated prompt." });
    // The user/assistant turns from before the switch are still in history, not wiped out.
    expect(provider.receivedMessages[1].some((m) => m.role === "user" && m.content === "hello")).toBe(true);
    expect(provider.receivedMessages[1].some((m) => m.content === "First reply.")).toBe(true);
  });

  it("reset() keeps whichever system prompt is currently set, not the original default", async () => {
    const provider = new ScriptedProvider([{ message: { role: "assistant", content: "ok" }, finishReason: "stop" }]);
    const agent = new Agent({
      getProvider: () => provider,
      getModel: () => "test-model",
      ctx: makeCtx(),
      tools: [],
      systemPrompt: "Initial prompt.",
    });

    agent.setSystemPrompt("Updated prompt.");
    agent.reset();

    expect(agent.getHistory()).toEqual([{ role: "system", content: "Updated prompt." }]);
  });
});

describe("Agent running independent read-only tool calls in parallel", () => {
  function delayedTool(name: string, delayMs: number, readOnly: boolean, log: number[]): ToolDefinition {
    return {
      spec: { name, description: name, parameters: { type: "object", properties: {} } },
      readOnly,
      async run() {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        log.push(Number(name.slice(-1)));
        return `${name} done`;
      },
    };
  }

  it("runs a same-turn batch of readOnly calls concurrently, cutting total wall-clock time", async () => {
    const finishOrder: number[] = [];
    const tools = [
      delayedTool("read_file_1", 60, true, finishOrder),
      delayedTool("read_file_2", 10, true, finishOrder),
      delayedTool("read_file_3", 30, true, finishOrder),
    ];
    const provider = new ScriptedProvider([
      {
        message: {
          role: "assistant",
          content: null,
          toolCalls: [
            { id: "c1", name: "read_file_1", arguments: "{}" },
            { id: "c2", name: "read_file_2", arguments: "{}" },
            { id: "c3", name: "read_file_3", arguments: "{}" },
          ],
        },
        finishReason: "tool_calls",
      },
      { message: { role: "assistant", content: "done" }, finishReason: "stop" },
    ]);
    const resultEvents: string[] = [];
    const agent = new Agent({
      getProvider: () => provider,
      getModel: () => "test-model",
      ctx: makeCtx(),
      tools,
      onToolResult: (name) => resultEvents.push(name),
    });

    const start = Date.now();
    await agent.send("investigate");
    const elapsed = Date.now() - start;

    // Sequential would take ~100ms (60+10+30); concurrent should be close to the slowest one
    // (60ms). A generous ceiling well under the sequential sum proves they actually overlapped.
    expect(elapsed).toBeLessThan(90);
    // The fastest tool (read_file_2, 10ms) actually finishes first under the hood...
    expect(finishOrder[0]).toBe(2);
    // ...but callbacks/history are still reported in the original request order (1, 2, 3), not
    // completion order, so the client's tool-card correlation never has to change.
    expect(resultEvents).toEqual(["read_file_1", "read_file_2", "read_file_3"]);
    const toolMessages = agent.getHistory().filter((m) => m.role === "tool");
    expect(toolMessages.map((m) => m.name)).toEqual(["read_file_1", "read_file_2", "read_file_3"]);
  });

  it("keeps a batch with any non-readOnly call fully sequential", async () => {
    const finishOrder: number[] = [];
    const tools = [
      delayedTool("read_file_1", 30, true, finishOrder),
      delayedTool("write_file_1", 30, false, finishOrder),
    ];
    const provider = new ScriptedProvider([
      {
        message: {
          role: "assistant",
          content: null,
          toolCalls: [
            { id: "c1", name: "read_file_1", arguments: "{}" },
            { id: "c2", name: "write_file_1", arguments: "{}" },
          ],
        },
        finishReason: "tool_calls",
      },
      { message: { role: "assistant", content: "done" }, finishReason: "stop" },
    ]);
    const agent = new Agent({
      getProvider: () => provider,
      getModel: () => "test-model",
      ctx: makeCtx(),
      tools,
    });

    const start = Date.now();
    await agent.send("do stuff");
    const elapsed = Date.now() - start;

    // Sequential: ~60ms (30+30). If this ran concurrently instead it'd be ~30ms — the floor here
    // catches an accidental "parallelize everything" regression.
    expect(elapsed).toBeGreaterThanOrEqual(55);
  });
});
