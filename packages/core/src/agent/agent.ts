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
  /** Defaults to the base SYSTEM_PROMPT. Pass buildSystemPrompt(presetId, customInstructions)
   *  to start with a prompt mode/custom instructions already applied. */
  systemPrompt?: string;
  onTextDelta?: (delta: string) => void;
  onToolCall?: (name: string, args: Record<string, unknown>) => void;
  onToolResult?: (name: string, result: string, error: boolean) => void;
}

export class Agent {
  private systemPrompt: string;
  private history: ChatMessage[];
  private readonly tools: ToolDefinition[];
  private readonly toolsByName: Map<string, ToolDefinition>;
  private readonly toolNames: Set<string>;

  constructor(private deps: AgentDeps) {
    this.systemPrompt = deps.systemPrompt ?? SYSTEM_PROMPT;
    this.history = [{ role: "system", content: this.systemPrompt }];
    this.tools = deps.tools ?? allTools;
    this.toolsByName = new Map(this.tools.map((t) => [t.spec.name, t]));
    this.toolNames = new Set(this.toolsByName.keys());
  }

  getHistory(): ChatMessage[] {
    return this.history;
  }

  /** Changes the system prompt in place — takes effect on the next send(), without discarding
   *  the conversation so far (unlike reset()). Use this for switching prompt mode/custom
   *  instructions mid-session. */
  setSystemPrompt(prompt: string): void {
    this.systemPrompt = prompt;
    if (this.history[0]?.role === "system") {
      this.history[0] = { role: "system", content: prompt };
    } else {
      this.history.unshift({ role: "system", content: prompt });
    }
  }

  reset(): void {
    this.history = [{ role: "system", content: this.systemPrompt }];
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

      await this.executeToolCalls(toolCalls);
    }

    return finalText;
  }

  /** Runs every tool call from one model turn. When the whole batch is readOnly tools (no side
   *  effects, no ordering dependency on each other — see ToolDefinition.readOnly), they run
   *  concurrently to cut wall-clock latency for multi-call investigation bursts (e.g. three
   *  read_file calls at once) — this doesn't reduce token usage, only how long the user waits for
   *  it, since the model still only sees one round of results either way. Results are still
   *  applied — onToolResult fired, history pushed — in the original request order regardless of
   *  which call actually finishes first, so callback/history ordering stays identical to the
   *  serial path and the client's tool-card correlation needs no changes. Anything else (a write,
   *  a mix, a single call) runs sequentially as before — never risk two mutating calls racing. */
  private async executeToolCalls(calls: { id: string; name: string; arguments?: string }[]): Promise<void> {
    const allReadOnly = calls.length > 1 && calls.every((c) => this.toolsByName.get(c.name)?.readOnly);
    if (!allReadOnly) {
      for (const call of calls) {
        this.applyToolRun(call, await this.runTool(call));
      }
      return;
    }
    const runs = calls.map((call) => this.runTool(call));
    for (let i = 0; i < calls.length; i++) {
      this.applyToolRun(calls[i], await runs[i]);
    }
  }

  private async runTool(
    call: { id: string; name: string; arguments?: string }
  ): Promise<{ output: string; images?: string[]; error: boolean }> {
    const tool = this.toolsByName.get(call.name);
    const args = this.parseArgs(call.arguments);

    this.deps.onToolCall?.(call.name, args);

    if (!tool) {
      return { output: `Error: unknown tool "${call.name}"`, error: true };
    }

    if (tool.requiresConfirmation) {
      const approved = await this.deps.ctx.confirm(
        `Allow tool "${call.name}" with args ${JSON.stringify(args)}?`
      );
      if (!approved) {
        return { output: "User declined to run this tool.", error: true };
      }
    }

    try {
      const raw = await tool.run(args, this.deps.ctx);
      const output = typeof raw === "string" ? raw : raw.text;
      const images = typeof raw === "string" ? undefined : raw.images;
      return { output, images, error: false };
    } catch (err) {
      return { output: `Error: ${err instanceof Error ? err.message : String(err)}`, error: true };
    }
  }

  private applyToolRun(
    call: { id: string; name: string },
    run: { output: string; images?: string[]; error: boolean }
  ): void {
    this.deps.onToolResult?.(call.name, run.output, run.error);
    this.history.push({ role: "tool", toolCallId: call.id, name: call.name, content: run.output });
    if (run.images?.length) {
      // A tool-role message can't carry images in the OpenAI-compatible wire format — this is
      // the only way a vision-capable model actually gets to see e.g. a browser_check screenshot
      // rather than just the console-error text that came back in the tool result above.
      this.history.push({
        role: "user",
        content: `(${call.name} screenshot above — look at it before continuing.)`,
        images: run.images,
      });
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
}