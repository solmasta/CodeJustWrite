import { describe, it, expect } from "vitest";
import { TranscriptRecorder, renderTranscriptMarkdown, sanitizeFilenameSlug, summarizableText } from "../src/transcript.js";

describe("TranscriptRecorder", () => {
  it("groups consecutive assistant deltas into a single entry", () => {
    const t = new TranscriptRecorder();
    t.user("hello");
    t.assistantDelta("Hi ");
    t.assistantDelta("there");
    t.assistantDelta("!");
    expect(t.getEntries()).toEqual([
      { type: "user", text: "hello" },
      { type: "assistant", text: "Hi there!" },
    ]);
  });

  it("starts a new assistant entry after a tool call/result interrupts streaming", () => {
    const t = new TranscriptRecorder();
    t.assistantDelta("Let me check that.");
    t.toolCall("read_file", { path: "a.ts" });
    t.toolResult("read_file", "contents", false);
    t.assistantDelta("Done.");
    expect(t.getEntries()).toEqual([
      { type: "assistant", text: "Let me check that." },
      { type: "tool_call", name: "read_file", args: { path: "a.ts" } },
      { type: "tool_result", name: "read_file", result: "contents", error: false },
      { type: "assistant", text: "Done." },
    ]);
  });

  it("closes an open assistant entry on a diff/log line", () => {
    const t = new TranscriptRecorder();
    t.assistantDelta("Applying a fix.");
    t.diff("--- a/x\n+++ b/x");
    t.assistantDelta("Applied.");
    expect(t.getEntries()).toEqual([
      { type: "assistant", text: "Applying a fix." },
      { type: "diff", text: "--- a/x\n+++ b/x" },
      { type: "assistant", text: "Applied." },
    ]);
  });

  it("ignores empty deltas without opening a spurious entry", () => {
    const t = new TranscriptRecorder();
    t.assistantDelta("");
    expect(t.getEntries()).toEqual([]);
    expect(t.assistantOpen).toBe(false);
  });

  it("reports assistantOpen while mid-stream and closes it on turnEnded", () => {
    const t = new TranscriptRecorder();
    expect(t.assistantOpen).toBe(false);
    t.assistantDelta("partial");
    expect(t.assistantOpen).toBe(true);
    t.turnEnded();
    expect(t.assistantOpen).toBe(false);
  });

  it("assistantOpen is false right after a tool call/result even with prior streamed text", () => {
    const t = new TranscriptRecorder();
    t.assistantDelta("thinking");
    t.toolCall("run_shell", { command: "ls" });
    expect(t.assistantOpen).toBe(false);
  });

  it("keeps entries in call order across a full user -> tool -> assistant turn", () => {
    const t = new TranscriptRecorder();
    t.user("run the tests");
    t.toolCall("run_tests", {});
    t.toolResult("run_tests", "5 passed", false);
    t.assistantDelta("All green.");
    t.turnEnded();
    expect(t.getEntries().map((e) => e.type)).toEqual(["user", "tool_call", "tool_result", "assistant"]);
  });
});

describe("renderTranscriptMarkdown", () => {
  it("renders user/assistant text in full and a repo-name/timestamp header", () => {
    const md = renderTranscriptMarkdown(
      [
        { type: "user", text: "add a login page" },
        { type: "assistant", text: "Sure, I'll add one." },
      ],
      "owner/repo",
      Date.parse("2026-01-01T00:00:00Z")
    );
    expect(md).toContain("# CodeJustWrite conversation — owner/repo");
    expect(md).toContain("Session started: 2026-01-01T00:00:00.000Z");
    expect(md).toContain("**You:** add a login page");
    expect(md).toContain("**Assistant:** Sure, I'll add one.");
  });

  it("summarizes a tool call's most relevant argument instead of dumping the full args object", () => {
    const md = renderTranscriptMarkdown(
      [{ type: "tool_call", name: "write_file", args: { path: "src/login.tsx", content: "x".repeat(5000) } }],
      "owner/repo",
      Date.now()
    );
    expect(md).toContain("> Ran `write_file(src/login.tsx)`");
    expect(md).not.toContain("x".repeat(100)); // the huge file content must never appear
  });

  it("previews a tool result instead of including its full content, and marks failures distinctly", () => {
    const md = renderTranscriptMarkdown(
      [
        { type: "tool_result", name: "read_file", result: "line1\nline2\n".repeat(500), error: false },
        { type: "tool_result", name: "run_shell", result: "command not found", error: true },
      ],
      "owner/repo",
      Date.now()
    );
    expect(md).toContain("> ✓ done —");
    expect(md).toContain("> ✗ failed — command not found");
    expect(md.length).toBeLessThan(2000); // the repeated 6000-char result must be truncated, not dumped
  });

  it("renders a diff entry as a +/- line-count summary, not the raw diff text", () => {
    // Shaped like actual createTwoFilesPatch output (see fs.ts's patchDiff) — its "Index: <file>"
    // header would be a useless first line to show, since the tool_call line already names the
    // file; a line-change count is the useful summary instead.
    const md = renderTranscriptMarkdown(
      [
        {
          type: "diff",
          text:
            "Index: x.ts\n===================================================================\n" +
            "--- x.ts\n+++ x.ts\n@@ -1,3 +1,3 @@\n a\n-old\n+new1\n+new2\n c",
        },
      ],
      "owner/repo",
      Date.now()
    );
    expect(md).toContain("> +2 −1 lines changed");
    expect(md).not.toContain("Index: x.ts");
    expect(md).not.toContain("old");
  });

  it("omits an assistant entry with no text (e.g. a tool-call-only turn)", () => {
    const md = renderTranscriptMarkdown([{ type: "assistant", text: "" }], "owner/repo", Date.now());
    expect(md).not.toContain("**Assistant:**");
  });
});

describe("sanitizeFilenameSlug", () => {
  it("lowercases and hyphenates a normal model reply", () => {
    expect(sanitizeFilenameSlug("Fix OOM Memory Leak")).toBe("fix-oom-memory-leak");
  });

  it("strips punctuation and collapses runs of separators into one hyphen", () => {
    expect(sanitizeFilenameSlug('"fix: the OOM/memory leak!!"')).toBe("fix-the-oom-memory-leak");
  });

  it("trims leading/trailing hyphens left over from stripped punctuation", () => {
    expect(sanitizeFilenameSlug("-- fix bug --")).toBe("fix-bug");
  });

  it("caps length at 60 characters without leaving a trailing hyphen", () => {
    const long = "word ".repeat(30).trim();
    const slug = sanitizeFilenameSlug(long);
    expect(slug.length).toBeLessThanOrEqual(60);
    expect(slug.endsWith("-")).toBe(false);
  });

  it("returns an empty string (not a fallback) when nothing usable survives", () => {
    expect(sanitizeFilenameSlug("!!! ??? ...")).toBe("");
    expect(sanitizeFilenameSlug("")).toBe("");
  });
});

describe("summarizableText", () => {
  it("includes only user/assistant text, skipping tool call/result/diff entries", () => {
    const text = summarizableText([
      { type: "user", text: "fix the bug" },
      { type: "tool_call", name: "read_file", args: { path: "a.ts" } },
      { type: "tool_result", name: "read_file", result: "...", error: false },
      { type: "diff", text: "some diff" },
      { type: "assistant", text: "Found it, fixing now." },
    ]);
    expect(text).toBe("User: fix the bug\nAssistant: Found it, fixing now.");
  });

  it("returns an empty string for a transcript with no user/assistant text", () => {
    expect(summarizableText([{ type: "tool_call", name: "read_file", args: {} }])).toBe("");
  });

  it("caps output length, keeping the most recent text rather than the oldest", () => {
    const entries = Array.from({ length: 50 }, (_, i) => ({
      type: "user" as const,
      text: `message number ${i}`,
    }));
    const text = summarizableText(entries, 100);
    expect(text.length).toBeLessThanOrEqual(100);
    expect(text).toContain("message number 49");
    expect(text).not.toContain("message number 0\n");
  });
});
