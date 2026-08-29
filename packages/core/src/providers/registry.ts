import { createOpenAICompatibleProvider } from "./openaiCompatible.js";
import type { LLMProvider } from "./types.js";
import type { CjwConfig, ProviderName } from "../config/config.js";

const DEEPINFRA_BASE_URL = "https://api.deepinfra.com/v1/openai";

export class ProviderRegistry {
  private cache = new Map<ProviderName, LLMProvider>();

  constructor(private cfg: CjwConfig) {}

  get(providerName: ProviderName): LLMProvider {
    const cached = this.cache.get(providerName);
    if (cached) return cached;

    let provider: LLMProvider;
    if (providerName === "openai") {
      if (!this.cfg.openaiApiKey) {
        throw new Error("OPENAI_API_KEY is not set. Add it to your .env to use the openai provider.");
      }
      provider = createOpenAICompatibleProvider({ name: "openai", apiKey: this.cfg.openaiApiKey });
    } else if (providerName === "deepinfra") {
      if (!this.cfg.deepinfraApiKey) {
        throw new Error("DEEPINFRA_API_KEY is not set. Add it to your .env to use the deepinfra provider.");
      }
      provider = createOpenAICompatibleProvider({
        name: "deepinfra",
        apiKey: this.cfg.deepinfraApiKey,
        baseURL: DEEPINFRA_BASE_URL,
      });
    } else {
      throw new Error(`Unknown provider: ${providerName}`);
    }

    this.cache.set(providerName, provider);
    return provider;
  }
}
