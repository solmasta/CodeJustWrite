import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { loadSettings, persistSettings } from "./settings";
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
      expect(settings.provider).toBe("openai");
      expect(settings.recentRepos).toEqual([]);
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
