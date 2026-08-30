import type { McpServerConfig } from "../mcp/types.js";

export type ProviderName = "deepinfra" | "openrouter";

export interface CjwConfig {
  provider: ProviderName;
  model: string;
  deepinfraApiKey?: string;
  openrouterApiKey?: string;
  githubToken?: string;
  shellTimeoutSec: number;
  mcpServers: McpServerConfig[];
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
    mcpServers: parseMcpServers(process.env.CJW_MCP_SERVERS),
  };
}

export function defaultModelFor(provider: ProviderName): string {
  return DEFAULT_MODELS[provider];
}

/**
 * CJW_MCP_SERVERS is a JSON array of McpServerConfig. Parsed leniently: a missing/empty value
 * means "no MCP servers" and a malformed value is logged and ignored rather than crashing
 * startup — one bad entry shouldn't prevent the agent's built-in tools from working.
 */
function parseMcpServers(raw: string | undefined): McpServerConfig[] {
  if (!raw?.trim()) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error("CJW_MCP_SERVERS must be a JSON array");
    return parsed.map((entry, i) => validateMcpServerConfig(entry, i));
  } catch (err) {
    console.warn(`[cjw] Ignoring invalid CJW_MCP_SERVERS: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

function validateMcpServerConfig(entry: unknown, index: number): McpServerConfig {
  if (typeof entry !== "object" || entry === null) {
    throw new Error(`CJW_MCP_SERVERS[${index}] is not an object`);
  }
  const e = entry as Record<string, unknown>;
  if (typeof e.name !== "string" || !e.name) {
    throw new Error(`CJW_MCP_SERVERS[${index}] is missing a "name" string`);
  }
  if (e.transport !== "stdio" && e.transport !== "http") {
    throw new Error(`CJW_MCP_SERVERS[${index}] ("${e.name}") needs "transport": "stdio" or "http"`);
  }
  if (e.transport === "stdio" && typeof e.command !== "string") {
    throw new Error(`CJW_MCP_SERVERS[${index}] ("${e.name}") is stdio but is missing "command"`);
  }
  if (e.transport === "http" && typeof e.url !== "string") {
    throw new Error(`CJW_MCP_SERVERS[${index}] ("${e.name}") is http but is missing "url"`);
  }
  return {
    name: e.name,
    transport: e.transport,
    command: typeof e.command === "string" ? e.command : undefined,
    args: Array.isArray(e.args) ? e.args.map(String) : undefined,
    url: typeof e.url === "string" ? e.url : undefined,
    apiKey: typeof e.apiKey === "string" ? e.apiKey : undefined,
    apiKeyEnvVar: typeof e.apiKeyEnvVar === "string" ? e.apiKeyEnvVar : undefined,
  };
}
