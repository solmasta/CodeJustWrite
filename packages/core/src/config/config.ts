export type ProviderName = "deepinfra" | "openrouter";

export interface CjwConfig {
  provider: ProviderName;
  model: string;
  deepinfraApiKey?: string;
  openrouterApiKey?: string;
  githubToken?: string;
  shellTimeoutSec: number;
}

const DEFAULT_MODELS: Record<ProviderName, string> = {
  deepinfra: "meta-llama/Meta-Llama-3.1-70B-Instruct",
  openrouter: "meta-llama/llama-3.1-70b-instruct",
};

export function loadConfig(): CjwConfig {
  const provider = (process.env.CJW_DEFAULT_PROVIDER as ProviderName) || "deepinfra";
  const model = process.env.CJW_DEFAULT_MODEL || DEFAULT_MODELS[provider] || DEFAULT_MODELS.deepinfra;

  return {
    provider,
    model,
    deepinfraApiKey: process.env.DEEPINFRA_KEY,
    openrouterApiKey: process.env.OPENROUTER_KEY,
    githubToken: process.env.GITHUB_TOKEN,
    shellTimeoutSec: Number(process.env.CJW_SHELL_TIMEOUT_SEC || 120),
  };
}

export function defaultModelFor(provider: ProviderName): string {
  return DEFAULT_MODELS[provider];
}
