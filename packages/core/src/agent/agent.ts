import { randomUUID } from "node:crypto";
import type { ChatMessage, LLMProvider } from "../providers/types.js";
import { allTools } from "./tools/index.js";
import type { ToolContext, ToolDefinition } from "./tools/index.js";
import { parseFakeToolCall } from "./fakeToolCall.js";
import { SYSTEM_PROMPT } from "./systemPrompt.js";

const MAX_TOOL_ITERATIONS = 25;

export interface CompactionConfig {
  /** Once the history's total resent size (content + image bytes) exceeds this, older large
   *  entries get compacted. Roughly 4 bytes/token, so the default leaves plenty of headroom on
   *  typical context windows even after a long session. */
  triggerBytes?: number;
  /** This many of the most recent messages are always left fully intact, however large — recent
   *  context is what the model actually needs right now. */
  keepRecentMessages?: number;
  /** A tool-result message's content below this size is left alone even during compaction — only
   *  the biggest, most token-expensive entries are worth shrinking. */
  minMessageBytes?: number;
}

const DEFAULT_COMPACTION: Required<CompactionConfig> = {
  triggerBytes: 150_000,
  keepRecentMessages: 12,
  minMessageBytes: 2_000,
};

function messageBytes(m: ChatMessage): number {
  return (m.content?.length ?? 0) + (m.images?.reduce((sum, img) => sum + img.length, 0) ?? 0);
}

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
  /** Tuning for automatic history compaction (see maybeCompactHistory). Defaults are sane for
   *  real usage; pass overrides mainly to keep test fixtures small. */
  compaction?: CompactionConfig;
  onTextDelta?: (delta: string) => void;
  /** callId identifies which call this is within its batch — a UI needs it to correlate this
   *  event with the right on-screen card, since parallel batches (see executeToolCalls) can fire
   *  several onToolCall events before any of their onToolResult events arrive; relying on "the
   *  most recently created card" silently attaches results to the wrong card once more than one
   *  call is ever in flight at once. */
  onToolCall?: (name: string, args: Record<string, unknown>, callId: string) => void;
  onToolResult?: (name: string, result: string, error: boolean, callId: string) => void;
}

export class Agent {
  private systemPrompt: string;
  private history: ChatMessage[];
  private readonly tools: ToolDefinition[];
  private readonly toolsByName: Map<string, ToolDefinition>;
  private readonly toolNames: Set<string>;
  private readonly compaction: Required<CompactionConfig>;

  constructor(private deps: AgentDeps) {
    this.systemPrompt = deps.systemPrompt ?? SYSTEM_PROMPT;
    this.history = [{ role: "system", content: this.systemPrompt }];
    this.tools = deps.tools ?? allTools;
    this.toolsByName = new Map(this.tools.map((t) => [t.spec.name, t]));
    this.toolNames = new Set(this.toolsByName.keys());
    this.compaction = { ...DEFAULT_COMPACTION, ...deps.compaction };
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

  /** Once the resent history grows past a byte threshold, replaces old large tool-result content
   *  and old screenshot images with short placeholders — never touching the system message or
   *  the most recent messages (see CompactionConfig). A tool-role message is never removed
   *  outright, only its content shrunk: every one has to stay paired with its assistant
   *  message's tool_call_id for the wire format to stay valid. Runs once per send() rather than
   *  continuously, since it's cheap relative to an actual LLM call. */
  private maybeCompactHistory(): void {
    const { triggerBytes, keepRecentMessages, minMessageBytes } = this.compaction;
    const totalBytes = this.history.reduce((sum, m) => sum + messageBytes(m), 0);
    if (totalBytes <= triggerBytes) return;

    const keepFromIndex = Math.max(1, this.history.length - keepRecentMessages);
    for (let i = 1; i < keepFromIndex; i++) {
      const msg = this.history[i];
      if (msg.role === "tool" && (msg.content?.length ?? 0) > minMessageBytes) {
        this.history[i] = {
          ...msg,
          content: `[compacted — ${msg.content!.length} bytes of older ${msg.name ?? "tool"} output omitted to save context; re-run the tool if you need it again]`,
        };
      } else if (msg.images?.length) {
        this.history[i] = {
          ...msg,
          content: msg.content
            ? `${msg.content} (older screenshot omitted to save context)`
            : "(older screenshot omitted to save context)",
          images: undefined,
        };
      }
    }
  }

  async send(userMessage: string): Promise<string> {
    this.history.push({ role: "user", content: userMessage });
    this.maybeCompactHistory();

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

  /** Runs every tool call from one model turn. A batch runs concurrently when every call is
   *  either readOnly (no side effects, no ordering dependency — see ToolDefinition.readOnly) or
   *  isolatedResource (no confirmation gate, and works against its own private resource — a temp
   *  worktree, a fresh browser instance — that can't collide with a readOnly read of the live
   *  tree), with at most one isolatedResource call per batch to avoid piling up e.g. two
   *  concurrent npm installs. This cuts wall-clock latency for multi-call bursts (e.g. read_file
   *  x3, or a read alongside run_tests) — it doesn't reduce token usage, since the model still
   *  only sees one round of results either way. Results are still applied — onToolResult fired,
   *  history pushed — in the original request order regardless of which call actually finishes
   *  first, so history ordering stays identical to the serial path. Callback ordering is a
   *  different story: a concurrent batch fires every onToolCall up front, before any of their
   *  onToolResult — a UI correlating "this result" to "whichever card was created most recently"
   *  (valid only under strict serial execution) will attach it to the wrong card. Callers must
   *  key off the callId argument now passed to both callbacks instead.
   *
   *  Deliberately NOT extended to confirmation-requiring tools (write_file, edit_file,
   *  delete_file, any git mutation, etc.), even ones that touch clearly distinct resources (two
   *  write_file calls to different paths, say): a confirmation is an interactive gate, and the
   *  CLI's readline-based prompt can only have one question pending at a time — two concurrent
   *  confirmation prompts there is not just a UX wrinkle, it breaks outright. Any batch with such
   *  a call, or a mix of anything else, runs sequentially — never risk two mutating calls racing. */
  private async executeToolCalls(calls: { id: string; name: string; arguments?: string }[]): Promise<void> {
    if (!this.canRunConcurrently(calls)) {
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

  private canRunConcurrently(calls: { name: string }[]): boolean {
    if (calls.length <= 1) return false;
    let isolatedCount = 0;
    for (const call of calls) {
      const tool = this.toolsByName.get(call.name);
      if (!tool) return false;
      if (tool.readOnly) continue;
      if (tool.isolatedResource) {
        isolatedCount++;
        if (isolatedCount > 1) return false;
        continue;
      }
      return false;
    }
    return true;
  }

  private async runTool(
    call: { id: string; name: string; arguments?: string }
  ): Promise<{ output: string; images?: string[]; error: boolean }> {
    const tool = this.toolsByName.get(call.name);
    const args = this.parseArgs(call.arguments);

    this.deps.onToolCall?.(call.name, args, call.id);

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
    this.deps.onToolResult?.(call.name, run.output, run.error, call.id);
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