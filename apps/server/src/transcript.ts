export interface TranscriptEntry {
  type: "user" | "assistant" | "tool_call" | "tool_result" | "diff";
  text?: string;
  name?: string;
  args?: Record<string, unknown>;
  result?: string;
  error?: boolean;
}

/**
 * Mirrors, in order, exactly what the live WS event stream already renders in the client's
 * scrolling chat feed — so a reconnecting client (a page reload mid-conversation, a dropped
 * connection) can rebuild the same transcript instead of the feed appearing wiped even though
 * the underlying Agent conversation is still intact server-side (see Session.attach).
 *
 * Assistant text arrives as a stream of onTextDelta chunks with no explicit "start"/"end" event
 * of its own, so consecutive deltas are grouped into one entry, closed out whenever anything
 * else happens (a tool call, a tool result, a diff line, or the turn finishing) — matching how
 * the client's own currentAssistantBubble accumulates deltas into a single bubble between those
 * same boundaries.
 */
export class TranscriptRecorder {
  private entries: TranscriptEntry[] = [];
  private open: TranscriptEntry | null = null;

  user(text: string): void {
    this.open = null;
    this.entries.push({ type: "user", text });
  }

  assistantDelta(delta: string): void {
    if (!delta) return;
    if (!this.open || this.open.type !== "assistant") {
      this.open = { type: "assistant", text: "" };
      this.entries.push(this.open);
    }
    this.open.text = (this.open.text ?? "") + delta;
  }

  toolCall(name: string, args: Record<string, unknown>): void {
    this.open = null;
    this.entries.push({ type: "tool_call", name, args });
  }

  toolResult(name: string, result: string, error: boolean): void {
    this.open = null;
    this.entries.push({ type: "tool_result", name, result, error });
  }

  diff(text: string): void {
    this.open = null;
    this.entries.push({ type: "diff", text });
  }

  /** Call once a turn (agent.send()) finishes or errors, closing any still-open assistant entry. */
  turnEnded(): void {
    this.open = null;
  }

  /** True while the model is mid-stream of a not-yet-finalized assistant reply — the caller uses
   *  this to tell a reconnecting client whether to keep appending live deltas to the last
   *  replayed bubble instead of starting a visually-duplicate new one. */
  get assistantOpen(): boolean {
    return this.open?.type === "assistant";
  }

  getEntries(): TranscriptEntry[] {
    return this.entries;
  }
}
