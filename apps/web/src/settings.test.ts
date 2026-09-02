import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { loadSettings, persistSettings, loadTranscript, appendTranscript, updateLastTranscriptEntry, clearTranscript } from "./settings";
import { debounce } from "./utils";

describe("settings", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  describe("loadSettings", () => {
    it("returns default settings when localStorage is empty", () => {
      const settings = loadSettings();
      expect(settings.serverUrl).toBe("");
      expect(settings.token).toBe("");
      expect(settings.provider).toBe("deepinfra");
      expect(settings.recentRepos).toEqual([]);
      expect(settings.promptPreset).toBe("default");
      expect(settings.customInstructions).toBe("");
    });

    it("loads settings from localStorage", () => {
      localStorage.setItem(
        "cjw.settings",
        JSON.stringify({ serverUrl: "http://localhost:3000", token: "test-token" })
      );
      const settings = loadSettings();
      expect(settings.serverUrl).toBe("http://localhost:3000");
      expect(settings.token).toBe("test-token");
    });

    it("ignores invalid JSON in localStorage", () => {
      localStorage.setItem("cjw.settings", "invalid json");
      const settings = loadSettings();
      expect(settings.serverUrl).toBe("");
      expect(settings.token).toBe("");
    });
  });

  describe("persistSettings", () => {
    it("saves settings to localStorage", () => {
      persistSettings({ serverUrl: "http://example.com" });
      const settings = loadSettings();
      expect(settings.serverUrl).toBe("http://example.com");
    });

    it("merges with existing settings", () => {
      persistSettings({ token: "old-token" });
      persistSettings({ serverUrl: "http://example.com" });
      const settings = loadSettings();
      expect(settings.token).toBe("old-token");
      expect(settings.serverUrl).toBe("http://example.com");
    });
  });
});

describe("transcript persistence", () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  afterEach(() => {
    sessionStorage.clear();
  });

  it("returns an empty array for a session with no transcript yet", () => {
    expect(loadTranscript("s1")).toEqual([]);
  });

  it("appends entries in order", () => {
    appendTranscript("s1", { kind: "user", text: "hi" });
    appendTranscript("s1", { kind: "assistant", text: "hello" });
    expect(loadTranscript("s1")).toEqual([
      { kind: "user", text: "hi" },
      { kind: "assistant", text: "hello" },
    ]);
  });

  it("keeps different sessions' transcripts independent", () => {
    appendTranscript("s1", { kind: "user", text: "for s1" });
    appendTranscript("s2", { kind: "user", text: "for s2" });
    expect(loadTranscript("s1")).toEqual([{ kind: "user", text: "for s1" }]);
    expect(loadTranscript("s2")).toEqual([{ kind: "user", text: "for s2" }]);
  });

  it("updateLastTranscriptEntry mutates only the most recent entry", () => {
    appendTranscript("s1", { kind: "tool", name: "list_dir", args: { path: "." } });
    updateLastTranscriptEntry("s1", (e) => (e.kind === "tool" ? { ...e, result: "a.txt, b.txt", error: false } : e));
    expect(loadTranscript("s1")).toEqual([
      { kind: "tool", name: "list_dir", args: { path: "." }, result: "a.txt, b.txt", error: false },
    ]);
  });

  it("updateLastTranscriptEntry is a no-op on an empty transcript", () => {
    updateLastTranscriptEntry("s1", (e) => ({ ...e, text: "should never run" }) as never);
    expect(loadTranscript("s1")).toEqual([]);
  });

  it("caps the transcript length, dropping the oldest entries first", () => {
    for (let i = 0; i < 305; i++) appendTranscript("s1", { kind: "user", text: `msg ${i}` });
    const stored = loadTranscript("s1");
    expect(stored.length).toBe(300);
    expect(stored[0]).toEqual({ kind: "user", text: "msg 5" });
    expect(stored[stored.length - 1]).toEqual({ kind: "user", text: "msg 304" });
  });

  it("clearTranscript removes only the named session's transcript", () => {
    appendTranscript("s1", { kind: "user", text: "keep me? no" });
    appendTranscript("s2", { kind: "user", text: "keep me" });
    clearTranscript("s1");
    expect(loadTranscript("s1")).toEqual([]);
    expect(loadTranscript("s2")).toEqual([{ kind: "user", text: "keep me" }]);
  });
});

describe("debounce", () => {
  it("delays function execution", async () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 100);
    
    debounced("arg1");
    expect(fn).not.toHaveBeenCalled();
    
    await new Promise((r) => setTimeout(r, 50));
    expect(fn).not.toHaveBeenCalled();
    
    await new Promise((r) => setTimeout(r, 100));
    expect(fn).toHaveBeenCalledWith("arg1");
  });

  it("cancels previous calls", async () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 100);
    
    debounced("first");
    debounced("second");
    
    await new Promise((r) => setTimeout(r, 150));
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith("second");
  });
});
