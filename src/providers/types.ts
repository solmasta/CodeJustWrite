export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  name: string;
  arguments: string; // raw JSON string, as returned by the model
}

export interface ChatMessage {
  role: Role;
  content: string | null;
  toolCalls?: ToolCall[];
  toolCallId?: string; // set on role:"tool" messages
  name?: string; // tool name, set on role:"tool" messages
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}

export interface CompletionResult {
  message: ChatMessage;
  finishReason: "stop" | "tool_calls" | "length" | "other";
}

export interface StreamHandlers {
  onTextDelta?: (delta: string) => void;
}

export interface LLMProvider {
  readonly name: string;
  complete(
    messages: ChatMessage[],
    tools: ToolSpec[],
    model: string,
    handlers?: StreamHandlers
  ): Promise<CompletionResult>;
}
