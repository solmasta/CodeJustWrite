import { describe, it, expect } from "vitest";
import { Agent } from "../src/agent/agent.js";
import type { ChatMessage, CompletionResult, LLMProvider, ModelInfo, StreamHandlers, ToolSpec } from "../src/providers/types.js";
import type { ToolContext, ToolDefinition } from "../src/agent/tools/types.js";

class ScriptedProvider implements LLMProvider {
  readonly name = "scripted";
  calls = 0;
  constructor(private readonly responses: CompletionResult[]) {}

  async complete(
    _messages: ChatMessage[],
    _tools: ToolSpec[],
    _model: string,
    _handlers?: StreamHandlers
  ): Promise<CompletionResult> {
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
