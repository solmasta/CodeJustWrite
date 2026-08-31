import OpenAI from "openai";
import type {
  ChatMessage,
  CompletionResult,
  LLMProvider,
  ModelInfo,
  StreamHandlers,
  ToolCall,
  ToolSpec,
} from "./types.js";

function toOpenAIMessages(messages: ChatMessage[]): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
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
      const stream = await client.chat.completions.create({
        model,
        messages: toOpenAIMessages(messages),
        tools: tools.length ? toOpenAITools(tools) : undefined,
        stream: true,
      });

      let content = "";
      const toolCallsById = new Map<number, { id: string; name: string; args: string }>();
      let finishReason: CompletionResult["finishReason"] = "stop";

      for await (const chunk of stream) {
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

      const toolCalls: ToolCall[] = [...toolCallsById.values()]
        .filter((tc) => tc.name)
        .map((tc) => ({ id: tc.id, name: tc.name, arguments: tc.args }));

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
