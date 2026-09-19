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
  /** Base64 data URLs to attach as image content, role:"user" only (e.g. a browser_check
   *  screenshot). Ignored for other roles — the wire format has no image slot for them. */
  images?: string[];
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
  /** Aborts the request if the provider hasn't responded within this many milliseconds, instead
   *  of falling back to the SDK's default (10 minutes) — for a one-off completion a caller is
   *  actively waiting on synchronously (not the main agent loop, which can legitimately take a
   *  while on a real conversation turn). */
  timeoutMs?: number;
}

export interface ModelInfo {
  id: string;
}

export interface LLMProvider {
  readonly name: string;
  complete(
    messages: ChatMessage[],
    tools: ToolSpec[],
    model: string,
    handlers?: StreamHandlers
  ): Promise<CompletionResult>;
  /** Live model catalog from the provider, so the UI can offer a real up-to-date list instead of a hardcoded guess. */
  listModels(): Promise<ModelInfo[]>;
}
