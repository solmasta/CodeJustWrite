import type { ToolDefinition } from "../agent/tools/types.js";

/**
 * A single MCP server to connect to, authenticated with a static credential
 * (an API key/token) rather than a full OAuth flow.
 */
export interface McpServerConfig {
  /** Short identifier for this server, used to namespace its tools (e.g. "github" -> mcp_github_<tool>). */
  name: string;
  transport: "stdio" | "http";
  /** stdio: the executable to spawn. */
  command?: string;
  args?: string[];
  /** http: the server's MCP endpoint URL (Streamable HTTP transport). */
  url?: string;
  /** Static credential for this server. Omit for servers that don't require one. */
  apiKey?: string;
  /** stdio only: env var name the apiKey is passed to the spawned process under. Defaults to "API_KEY". */
  apiKeyEnvVar?: string;
}

export interface McpServerStatus {
  name: string;
  connected: boolean;
  toolCount: number;
  error?: string;
}

export interface McpConnections {
  /** Tools from every server that connected successfully, ready to merge into the agent's tool list. */
  tools: ToolDefinition[];
  /** One entry per configured server, including ones that failed to connect. */
  statuses: McpServerStatus[];
  /** Disconnects every server that connected (closes stdio subprocesses / HTTP sessions). */
  close(): Promise<void>;
}
