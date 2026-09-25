import { createOpenAICompatibleProvider } from "./openaiCompatible.js";
import type { LLMProvider } from "./types.js";
import type { CjwConfig, ProviderName } from "../config/config.js";

export class ProviderRegistry {
  private cache = new Map<ProviderName, LLMProvider>();

  constructor(private cfg: CjwConfig) {}

  get(providerName: ProviderName): LLMProvider {
    const cached = this.cache.get(providerName);
    if (cached) return cached;

    let provider: LLMProvider;
    if (providerName === "local") {
      // Ollama/llama.cpp/LM Studio's local OpenAI-compatible servers don't check the API key,
      // but the OpenAI SDK still requires a non-empty string to construct a client.
      provider = createOpenAICompatibleProvider({
        name: "local",
        apiKey: "local",
        baseURL: this.cfg.localBaseUrl,
      });
    } else {
      throw new Error(`Unknown provider: ${providerName}`);
    }

    this.cache.set(providerName, provider);
    return provider;
  }
}
