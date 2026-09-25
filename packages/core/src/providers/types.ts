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
  /** Aborts a streaming reply once this many milliseconds pass with no new chunk arriving.
   *  Defaults to STREAM_IDLE_TIMEOUT_MS. The SDK's own timeout only covers getting the response
   *  started — a stream that stalls midway (flaky upstream, a provider-side hang) would otherwise
   *  leave the turn, and the session's busy flag with it, stuck forever. */
  idleTimeoutMs?: number;
}

export const STREAM_IDLE_TIMEOUT_MS = 180_000;

export interface ModelInfo {
  id: string;
}

/** Thrown by a provider's complete() when the *model itself* is the problem — not found/not
 *  pulled locally (404), or rate-limited (429) — as opposed to a network failure, an auth
 *  problem, or a bad request, none of which switching models would fix. The agent loop uses
 *  this specifically to decide whether falling back to a different model is a sane response to
 *  a given failure. */
export class ModelUnavailableError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "ModelUnavailableError";
  }
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
