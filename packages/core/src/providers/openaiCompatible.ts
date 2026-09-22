import OpenAI from "openai";
import {
  ModelUnavailableError,
  STREAM_IDLE_TIMEOUT_MS,
  type ChatMessage,
  type CompletionResult,
  type LLMProvider,
  type ModelInfo,
  type StreamHandlers,
  type ToolCall,
  type ToolSpec,
} from "./types.js";

export function toOpenAIMessages(messages: ChatMessage[]): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  return messages.map((m) => {
    if (m.role === "tool") {
      return {
        role: "tool",
        tool_call_id: m.toolCallId!,
        content: m.content ?? "",
      };
    }
    if (m.role === "assistant") {
      return {
        role: "assistant",
        content: m.content,
        tool_calls: m.toolCalls?.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: { name: tc.name, arguments: tc.arguments },
        })),
      };
    }
    if (m.role === "user" && m.images?.length) {
      const parts: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];
      if (m.content) parts.push({ type: "text", text: m.content });
      for (const dataUrl of m.images) parts.push({ type: "image_url", image_url: { url: dataUrl } });
      return { role: "user", content: parts };
    }
    return { role: m.role as "system" | "user", content: m.content ?? "" };
  });
}

function toOpenAITools(tools: ToolSpec[]): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

export interface OpenAICompatibleOptions {
  name: string;
  apiKey: string;
  baseURL?: string;
}

/**
 * Both OpenAI and DeepInfra speak the OpenAI chat-completions wire format
 * (DeepInfra via its /v1/openai compatibility endpoint), so one client
 * implementation covers both — only apiKey/baseURL differ.
 */
export function createOpenAICompatibleProvider(opts: OpenAICompatibleOptions): LLMProvider {
  const client = new OpenAI({ apiKey: opts.apiKey, baseURL: opts.baseURL });

  return {
    name: opts.name,

    async complete(
      messages: ChatMessage[],
      tools: ToolSpec[],
      model: string,
      handlers?: StreamHandlers
    ): Promise<CompletionResult> {
      const idleTimeoutMs = handlers?.idleTimeoutMs ?? STREAM_IDLE_TIMEOUT_MS;
      const abort = new AbortController();
      let stalled = false;
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      const armIdleTimer = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          stalled = true;
          abort.abort();
        }, idleTimeoutMs);
      };
      const stalledError = () =>
        new Error(`The model stopped responding (no data for ${Math.round(idleTimeoutMs / 1000)}s). Please try again.`);

      armIdleTimer();
      let stream;
      try {
        stream = await client.chat.completions.create(
          {
            model,
            messages: toOpenAIMessages(messages),
            tools: tools.length ? toOpenAITools(tools) : undefined,
            stream: true,
          },
          {
            signal: abort.signal,
            ...(handlers?.timeoutMs !== undefined ? { timeout: handlers.timeoutMs } : {}),
          }
        );
      } catch (err) {
        clearTimeout(idleTimer);
        if (stalled) throw stalledError();
        // 404 covers a model slug that's gone entirely or, as happened in production, a ":free"
        // variant whose free tier the provider pulled out from under it without warning; 429
        // covers the free tier's own rate limit. Both are "this model, right now, isn't usable"
        // rather than a real request/auth/network problem — tagged distinctly so the agent loop
        // can treat them as "try a different model" instead of just failing the turn outright.
        if (err instanceof OpenAI.APIError && (err.status === 404 || err.status === 429)) {
          throw new ModelUnavailableError(err.message, err.status);
        }
        throw err;
      }

      let content = "";
      const toolCallsById = new Map<number, { id: string; name: string; args: string }>();
      let finishReason: CompletionResult["finishReason"] = "stop";

      try {
        for await (const chunk of stream) {
          armIdleTimer();
          const choice = chunk.choices[0];
          if (!choice) continue;

          const delta = choice.delta;
          if (delta?.content) {
            content += delta.content;
            handlers?.onTextDelta?.(delta.content);
          }

          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index;
              const existing = toolCallsById.get(idx) ?? { id: "", name: "", args: "" };
              if (tc.id) existing.id = tc.id;
              if (tc.function?.name) existing.name += tc.function.name;
              if (tc.function?.arguments) existing.args += tc.function.arguments;
              toolCallsById.set(idx, existing);
            }
          }

          if (choice.finish_reason) {
            if (choice.finish_reason === "tool_calls") finishReason = "tool_calls";
            else if (choice.finish_reason === "length") finishReason = "length";
            else if (choice.finish_reason === "stop") finishReason = "stop";
            else finishReason = "other";
          }
        }
        // The SDK ends the iteration quietly (no throw) when its request is aborted, so this is
        // the path a stall usually takes — without it, a truncated reply would pass as complete.
        if (stalled) throw stalledError();
      } catch (err) {
        if (stalled) throw stalledError();
        throw err;
      } finally {
        clearTimeout(idleTimer);
      }

      const toolCalls: ToolCall[] = [...toolCallsById.values()]
        .filter((tc) => tc.name)
        // A tool with no parameters (e.g. git_status's schema is `{type:"object",properties:{}}`)
        // can have a model stream zero `arguments` delta chunks for it at all, leaving `args` at
        // its initial "" — not the same as "{}". That's fine locally (agent.ts's parseArgs()
        // treats a falsy raw string as {}), but this exact message also gets replayed back to the
        // provider as conversation history on the *next* turn, and "" isn't valid JSON — the
        // provider then rejects the whole next request with a 400 ("malformed JSON arguments"),
        // breaking every tool with an empty parameter schema after its first successful call.
        .map((tc) => ({ id: tc.id, name: tc.name, arguments: tc.args || "{}" }));

      return {
        message: {
          role: "assistant",
          content: content || null,
          toolCalls: toolCalls.length ? toolCalls : undefined,
        },
        finishReason: toolCalls.length ? "tool_calls" : finishReason,
      };
    },

    async listModels(): Promise<ModelInfo[]> {
      // The SDK's default request timeout is 10 minutes — fine for a chat completion, but this
      // backs a UI dropdown someone is actively waiting on. If the provider's /models endpoint is
      // slow or hanging rather than erroring outright, fail fast with a clear error instead of
      // leaving the settings UI stuck on "Loading…" for minutes with nothing to show for it.
      const page = await client.models.list({ timeout: 15_000 });
      const models: ModelInfo[] = [];
      for await (const m of page) {
        models.push({ id: m.id });
      }
      return models.sort((a, b) => a.id.localeCompare(b.id));
    },
  };
}
