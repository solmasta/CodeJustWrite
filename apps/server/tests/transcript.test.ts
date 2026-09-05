import { describe, it, expect } from "vitest";
import { TranscriptRecorder } from "../src/transcript.js";

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
