import { randomUUID } from "node:crypto";
import type { ChatMessage, LLMProvider } from "../providers/types.js";
import { allTools } from "./tools/index.js";
import type { ToolContext, ToolDefinition } from "./tools/index.js";
import { parseFakeToolCall } from "./fakeToolCall.js";
import { SYSTEM_PROMPT } from "./systemPrompt.js";

const MAX_TOOL_ITERATIONS = 25;

export interface AgentDeps {
  getProvider: () => LLMProvider;
  getModel: () => string;
  ctx: ToolContext;
  /** Defaults to the built-in tool set (git/shell/tests/browser/PR). Pass a superset — e.g.
   *  [...allTools, ...mcpTools] — to add tools from connected MCP servers. */
  tools?: ToolDefinition[];
  onTextDelta?: (delta: string) => void;
  onToolCall?: (name: string, args: Record<string, unknown>) => void;
  onToolResult?: (name: string, result: string, error: boolean) => void;
}

export class Agent {
  private history: ChatMessage[] = [{ role: "system", content: SYSTEM_PROMPT }];
  private readonly tools: ToolDefinition[];
  private readonly toolsByName: Map<string, ToolDefinition>;
  private readonly toolNames: Set<string>;

  constructor(private deps: AgentDeps) {
    this.tools = deps.tools ?? allTools;
    this.toolsByName = new Map(this.tools.map((t) => [t.spec.name, t]));
    this.toolNames = new Set(this.toolsByName.keys());
  }

  getHistory(): ChatMessage[] {
    return this.history;
  }

  reset(): void {
    this.history = [{ role: "system", content: SYSTEM_PROMPT }];
  }

  async send(userMessage: string): Promise<string> {
    this.history.push({ role: "user", content: userMessage });

    let finalText = "";

    for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
      const provider = this.deps.getProvider();
      const model = this.deps.getModel();

      const result = await provider.complete(this.history, this.tools.map((t) => t.spec), model, {
        onTextDelta: this.deps.onTextDelta,
      });

      this.history.push(result.message);

      let toolCalls = result.message.toolCalls;
      if (result.finishReason !== "tool_calls" || !toolCalls?.length) {
        // Some models never use real function-calling and instead write out a plain-text reply
        // that's just what a tool call would look like — the API sees an ordinary finished turn,
        // so nothing executes and the conversation stalls with the raw JSON as the "answer".
        // Recover that into a real call so the loop can actually run it and keep going.
        const recovered = parseFakeToolCall(result.message.content, this.toolNames);
        if (!recovered) {
          finalText = result.message.content ?? "";
          break;
        }
        const syntheticCall = { id: randomUUID(), name: recovered.name, arguments: JSON.stringify(recovered.arguments) };
        result.message.content = null;
        result.message.toolCalls = [syntheticCall];
        toolCalls = [syntheticCall];
      }

      for (const call of toolCalls) {
        await this.executeToolCall(call);
      }
    }

    return finalText;
  }

  private async executeToolCall(call: { id: string; name: string; arguments?: string }): Promise<void> {
    const tool = this.toolsByName.get(call.name);
    const args = this.parseArgs(call.arguments);

    this.deps.onToolCall?.(call.name, args);

    if (!tool) {
      this.addToolError(call.id, call.name, `Error: unknown tool "${call.name}"`);
      return;
    }

    if (tool.requiresConfirmation) {
      const approved = await this.deps.ctx.confirm(
        `Allow tool "${call.name}" with args ${JSON.stringify(args)}?`
      );
      if (!approved) {
        this.addToolError(call.id, call.name, "User declined to run this tool.");
        return;
      }
    }

    try {
      const raw = await tool.run(args, this.deps.ctx);
      const output = typeof raw === "string" ? raw : raw.text;
      const images = typeof raw === "string" ? undefined : raw.images;
      this.deps.onToolResult?.(call.name, output, false);
      this.history.push({ role: "tool", toolCallId: call.id, name: call.name, content: output });
      if (images?.length) {
        // A tool-role message can't carry images in the OpenAI-compatible wire format — this is
        // the only way a vision-capable model actually gets to see e.g. a browser_check screenshot
        // rather than just the console-error text that came back in the tool result above.
        this.history.push({
          role: "user",
          content: `(${call.name} screenshot above — look at it before continuing.)`,
          images,
        });
      }
    } catch (err) {
      const msg = `Error: ${err instanceof Error ? err.message : String(err)}`;
      this.deps.onToolResult?.(call.name, msg, true);
      this.history.push({ role: "tool", toolCallId: call.id, name: call.name, content: msg });
    }
  }

  private parseArgs(raw?: string): Record<string, unknown> {
    if (!raw) return {};
    try {
      return JSON.parse(raw);
    } catch {
      this.history.push({
        role: "tool",
        content: `Error: could not parse arguments JSON: ${raw}`,
      });
      return {};
    }
  }

  private addToolError(callId: string, name: string, content: string): void {
    this.deps.onToolResult?.(name, content, true);
    this.history.push({ role: "tool", toolCallId: callId, name, content });
  }
}