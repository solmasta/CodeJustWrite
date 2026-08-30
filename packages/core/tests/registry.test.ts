import { describe, it, expect } from "vitest";
import { ProviderRegistry } from "../src/providers/registry.js";
import { makeConfig } from "./testUtils.js";

describe("ProviderRegistry", () => {
  it("creates a deepinfra provider when DEEPINFRA_KEY is configured", () => {
    const registry = new ProviderRegistry(makeConfig({ deepinfraApiKey: "di-test" }));
    expect(registry.get("deepinfra").name).toBe("deepinfra");
  });

  it("creates an openrouter provider when OPENROUTER_KEY is configured", () => {
    const registry = new ProviderRegistry(makeConfig({ openrouterApiKey: "or-test" }));
    expect(registry.get("openrouter").name).toBe("openrouter");
  });

  it("throws a clear error naming the missing env var for each provider", () => {
    const registry = new ProviderRegistry(makeConfig());
    expect(() => registry.get("deepinfra")).toThrow(/DEEPINFRA_KEY/);
    expect(() => registry.get("openrouter")).toThrow(/OPENROUTER_KEY/);
  });

  it("caches providers so repeated get() calls for the same provider don't re-throw", () => {
    const registry = new ProviderRegistry(makeConfig({ deepinfraApiKey: "di-test" }));
    const first = registry.get("deepinfra");
    const second = registry.get("deepinfra");
    expect(first).toBe(second);
  });
});
