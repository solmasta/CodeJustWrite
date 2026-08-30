export type ProviderName = "openai" | "deepinfra" | "openrouter";

export interface CjwConfig {
  provider: ProviderName;
  model: string;
  openaiApiKey?: string;
  deepinfraApiKey?: string;
  openrouterApiKey?: string;
  githubToken?: string;
  shellTimeoutSec: number;
}

const DEFAULT_MODELS: Record<ProviderName, string> = {
  openai: "gpt-4.1",
  deepinfra: "meta-llama/Meta-Llama-3.1-70B-Instruct",
  openrouter: "openai/gpt-4o-mini",
};

export function loadConfig(): CjwConfig {
  const provider = (process.env.CJW_DEFAULT_PROVIDER as ProviderName) || "openai";
  const model = process.env.CJW_DEFAULT_MODEL || DEFAULT_MODELS[provider] || DEFAULT_MODELS.openai;

  return {
    provider,
    model,
    openaiApiKey: process.env.OPENAI_API_KEY,
    deepinfraApiKey: process.env.DEEPINFRA_KEY,
    openrouterApiKey: process.env.OPENROUTER_KEY,
    githubToken: process.env.GITHUB_TOKEN,
    shellTimeoutSec: Number(process.env.CJW_SHELL_TIMEOUT_SEC || 120),
  };
}

export function defaultModelFor(provider: ProviderName): string {
  return DEFAULT_MODELS[provider];
}
