import { describe, it, expect } from "vitest";
import { ProviderRegistry } from "../src/providers/registry.js";
import { makeConfig } from "./testUtils.js";

describe("ProviderRegistry", () => {
  it("creates a local provider with no API key required", () => {
    const registry = new ProviderRegistry(makeConfig());
    expect(registry.get("local").name).toBe("local");
  });

  it("caches providers so repeated get() calls for the same provider don't re-throw", () => {
    const registry = new ProviderRegistry(makeConfig());
    const first = registry.get("local");
    const second = registry.get("local");
    expect(first).toBe(second);
  });
});
