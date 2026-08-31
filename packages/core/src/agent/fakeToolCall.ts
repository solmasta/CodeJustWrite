export interface RecoveredToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

function stripCodeFence(text: string): string {
  const match = text.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
  return match ? match[1].trim() : text;
}

function asArgsObject(value: unknown): Record<string, unknown> | null {
  if (typeof value === "object" && value !== null) return value as Record<string, unknown>;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Some models — especially smaller/older ones — don't reliably use the API's actual
 * function-calling mechanism even when given a tool list: instead of a real `tool_calls` entry,
 * they write out a plain-text reply whose entire content is what a tool call *would* look like
 * (`{"name": "list_dir", "arguments": {"path": "."}}`, or the same shape wrapped in
 * `{"type": "function", ...}`, `{"function": {...}}`, a `parameters` key instead of `arguments`,
 * or a markdown code fence). The API sees this as a normal finished turn — finishReason "stop"
 * with ordinary content — so nothing actually executes and the conversation just stalls with no
 * real information gathered.
 *
 * Recovers that specific shape into a real tool call so the agent loop can execute it and keep
 * going, rather than silently showing the raw JSON as if it were the model's answer. Requires an
 * exact-match against a real registered tool name so unrelated JSON in a genuine answer (e.g. a
 * JSON example the model is explaining) isn't misread as a tool call.
 */
export function parseFakeToolCall(content: string | null, knownToolNames: ReadonlySet<string>): RecoveredToolCall | null {
  if (!content) return null;
  const trimmed = stripCodeFence(content.trim());
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const candidates: unknown[] = [parsed];
  const nestedFunction = (parsed as Record<string, unknown>).function;
  if (typeof nestedFunction === "object" && nestedFunction !== null) candidates.push(nestedFunction);

  for (const candidate of candidates) {
    const obj = candidate as Record<string, unknown>;
    const name = obj.name;
    if (typeof name !== "string" || !knownToolNames.has(name)) continue;
    const args = asArgsObject(obj.arguments ?? obj.parameters ?? {});
    if (args) return { name, arguments: args };
  }
  return null;
}
