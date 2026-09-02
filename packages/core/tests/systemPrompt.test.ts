import { describe, it, expect } from "vitest";
import { SYSTEM_PROMPT, PROMPT_PRESETS, DEFAULT_PROMPT_PRESET_ID, buildSystemPrompt } from "../src/agent/systemPrompt.js";

describe("buildSystemPrompt", () => {
  it("returns just the base prompt for the default preset with no custom instructions", () => {
    expect(buildSystemPrompt()).toBe(SYSTEM_PROMPT);
    expect(buildSystemPrompt(DEFAULT_PROMPT_PRESET_ID)).toBe(SYSTEM_PROMPT);
  });

  it("appends a non-default preset's instructions after the base prompt", () => {
    const result = buildSystemPrompt("tdd");
    expect(result.startsWith(SYSTEM_PROMPT)).toBe(true);
    expect(result).toContain("Test-Driven");
  });

  it("falls back to the default preset for an unknown/stale preset id rather than throwing", () => {
    expect(buildSystemPrompt("some-removed-preset")).toBe(SYSTEM_PROMPT);
  });

  it("appends custom instructions, trimmed, after the preset's own instructions", () => {
    const result = buildSystemPrompt("default", "  Always use tabs, not spaces.  ");
    expect(result).toContain("Always use tabs, not spaces.");
    expect(result).not.toContain("  Always use tabs");
  });

  it("ignores blank/whitespace-only custom instructions", () => {
    expect(buildSystemPrompt("default", "   ")).toBe(SYSTEM_PROMPT);
  });

  it("combines a preset and custom instructions together", () => {
    const result = buildSystemPrompt("security", "Flag anything touching payment data.");
    expect(result).toContain("Mode: Security Review");
    expect(result).toContain("Flag anything touching payment data.");
  });

  it("every preset has a unique id and non-empty label/description", () => {
    const ids = PROMPT_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const preset of PROMPT_PRESETS) {
      expect(preset.label.length).toBeGreaterThan(0);
      expect(preset.description.length).toBeGreaterThan(0);
    }
  });
});
