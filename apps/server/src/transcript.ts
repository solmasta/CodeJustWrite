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

function summarizeArgs(args: Record<string, unknown> | undefined): string {
  if (!args) return "";
  const preferredKeys = ["path", "pattern", "command", "url", "branch", "title", "message", "script", "pullNumber"];
  for (const key of preferredKeys) {
    const value = args[key];
    if (value === undefined || value === null || value === "") continue;
    const s = String(value);
    return s.length > 60 ? s.slice(0, 57) + "…" : s;
  }
  return "";
}

/**
 * Renders a recorded transcript into a compact, human-readable Markdown note for the "back up
 * this conversation to Drive" feature — the user's own messages and the assistant's replies in
 * full, but tool activity summarized to one line each (a preview of the result, not its full
 * content) rather than dumping file contents/diffs wholesale. The point is a readable record of
 * what was being worked on and why, not a second copy of the code itself — that's what git/
 * GitHub already is for.
 */
export function renderBackupMarkdown(entries: TranscriptEntry[], repoName: string, startedAt: number): string {
  const lines: string[] = [
    `# CodeJustWrite backup — ${repoName}`,
    "",
    `Saved: ${new Date().toISOString()}`,
    `Session started: ${new Date(startedAt).toISOString()}`,
    "",
    "---",
    "",
  ];
  for (const entry of entries) {
    switch (entry.type) {
      case "user":
        lines.push(`**You:** ${entry.text ?? ""}`, "");
        break;
      case "assistant":
        if (entry.text) lines.push(`**Assistant:** ${entry.text}`, "");
        break;
      case "tool_call": {
        const summary = summarizeArgs(entry.args);
        lines.push(`> Ran \`${entry.name}${summary ? `(${summary})` : ""}\``);
        break;
      }
      case "tool_result": {
        const preview = (entry.result ?? "").replace(/\s+/g, " ").trim().slice(0, 160);
        lines.push(`> ${entry.error ? "✗ failed" : "✓ done"}${preview ? ` — ${preview}` : ""}`, "");
        break;
      }
      case "diff":
        lines.push(`> ${(entry.text ?? "").split("\n")[0]}`, "");
        break;
    }
  }
  return lines.join("\n");
}
