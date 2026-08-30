import type { ChatMessage, LLMProvider } from "../providers/types.js";
import { allTools, toolsByName } from "./tools/index.js";
import type { ToolContext } from "./tools/index.js";
import { SYSTEM_PROMPT } from "./systemPrompt.js";

const MAX_TOOL_ITERATIONS = 25;

export interface AgentDeps {
  getProvider: () => LLMProvider;
  getModel: () => string;
  ctx: ToolContext;
  onTextDelta?: (delta: string) => void;
  onToolCall?: (name: string, args: Record<string, unknown>) => void;
  onToolResult?: (name: string, result: string, error: boolean) => void;
}

export class Agent {
  private history: ChatMessage[] = [{ role: "system", content: SYSTEM_PROMPT }];

  constructor(private deps: AgentDeps) {}

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

      const result = await provider.complete(this.history, allTools.map((t) => t.spec), model, {
        onTextDelta: this.deps.onTextDelta,
      });

      this.history.push(result.message);

      const toolCalls = result.message.toolCalls;
      if (result.finishReason !== "tool_calls" || !toolCalls?.length) {
        finalText = result.message.content ?? "";
        break;
      }

      for (const call of toolCalls) {
        await this.executeToolCall(call);
      }
    }

    return finalText;
  }

  private async executeToolCall(call: { id: string; name: string; arguments?: string }): Promise<void> {
    const tool = toolsByName.get(call.name);
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
      const output = await tool.run(args, this.deps.ctx);
      this.deps.onToolResult?.(call.name, output, false);
      this.history.push({ role: "tool", toolCallId: call.id, name: call.name, content: output });
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