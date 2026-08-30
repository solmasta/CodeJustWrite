import { createOpenAICompatibleProvider } from "./openaiCompatible.js";
import type { LLMProvider } from "./types.js";
import type { CjwConfig, ProviderName } from "../config/config.js";

const DEEPINFRA_BASE_URL = "https://api.deepinfra.com/v1/openai";
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

export class ProviderRegistry {
  private cache = new Map<ProviderName, LLMProvider>();

  constructor(private cfg: CjwConfig) {}

  get(providerName: ProviderName): LLMProvider {
    const cached = this.cache.get(providerName);
    if (cached) return cached;

    let provider: LLMProvider;
    if (providerName === "deepinfra") {
      if (!this.cfg.deepinfraApiKey) {
        throw new Error("DEEPINFRA_KEY is not set. Add it to your .env to use the deepinfra provider.");
      }
      provider = createOpenAICompatibleProvider({
        name: "deepinfra",
        apiKey: this.cfg.deepinfraApiKey,
        baseURL: DEEPINFRA_BASE_URL,
      });
    } else if (providerName === "openrouter") {
      if (!this.cfg.openrouterApiKey) {
        throw new Error("OPENROUTER_KEY is not set. Add it to your .env to use the openrouter provider.");
      }
      provider = createOpenAICompatibleProvider({
        name: "openrouter",
        apiKey: this.cfg.openrouterApiKey,
        baseURL: OPENROUTER_BASE_URL,
      });
    } else {
      throw new Error(`Unknown provider: ${providerName}`);
    }

    this.cache.set(providerName, provider);
    return provider;
  }
}
