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

      const result = await provider.complete(
        this.history,
        allTools.map((t) => t.spec),
        model,
        { onTextDelta: this.deps.onTextDelta }
      );

      this.history.push(result.message);

      if (result.finishReason !== "tool_calls" || !result.message.toolCalls?.length) {
        finalText = result.message.content ?? "";
        break;
      }

      for (const call of result.message.toolCalls) {
        const tool = toolsByName.get(call.name);
        let args: Record<string, unknown> = {};
        try {
          args = call.arguments ? JSON.parse(call.arguments) : {};
        } catch {
          this.history.push({
            role: "tool",
            toolCallId: call.id,
            name: call.name,
            content: `Error: could not parse arguments JSON: ${call.arguments}`,
          });
          continue;
        }

        this.deps.onToolCall?.(call.name, args);

        if (!tool) {
          const msg = `Error: unknown tool "${call.name}"`;
          this.deps.onToolResult?.(call.name, msg, true);
          this.history.push({ role: "tool", toolCallId: call.id, name: call.name, content: msg });
          continue;
        }

        if (tool.requiresConfirmation) {
          const approved = await this.deps.ctx.confirm(
            `Allow tool "${call.name}" with args ${JSON.stringify(args)}?`
          );
          if (!approved) {
            const msg = "User declined to run this tool.";
            this.deps.onToolResult?.(call.name, msg, true);
            this.history.push({ role: "tool", toolCallId: call.id, name: call.name, content: msg });
            continue;
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
    }

    return finalText;
  }
}
