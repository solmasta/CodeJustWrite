import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ToolDefinition } from "../agent/tools/types.js";
import type { McpConnections, McpServerConfig, McpServerStatus } from "./types.js";

const CLIENT_INFO = { name: "codejustwrite", version: "0.1.0" };

function sanitizeNamePart(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "_");
}

interface McpContentBlock {
  type: string;
  text?: string;
}

function extractText(result: { content?: McpContentBlock[] }): string {
  if (!result.content?.length) return "(no output)";
  return result.content
    .map((block) => (block.type === "text" ? (block.text ?? "") : `[${block.type} content omitted]`))
    .join("\n");
}

function buildTransport(cfg: McpServerConfig): Transport {
  if (cfg.transport === "stdio") {
    if (!cfg.command) throw new Error(`stdio server "${cfg.name}" is missing "command"`);
    const env = { ...getDefaultEnvironment() };
    if (cfg.apiKey) env[cfg.apiKeyEnvVar || "API_KEY"] = cfg.apiKey;
    return new StdioClientTransport({ command: cfg.command, args: cfg.args, env });
  }
  if (!cfg.url) throw new Error(`http server "${cfg.name}" is missing "url"`);
  return new StreamableHTTPClientTransport(new URL(cfg.url), {
    requestInit: cfg.apiKey ? { headers: { Authorization: `Bearer ${cfg.apiKey}` } } : undefined,
  });
}

async function connectOne(
  cfg: McpServerConfig
): Promise<{ tools: ToolDefinition[]; status: McpServerStatus; close: () => Promise<void> }> {
  const client = new Client(CLIENT_INFO);
  try {
    await client.connect(buildTransport(cfg));
    const listed = await client.listTools();

    const tools: ToolDefinition[] = listed.tools.map((remoteTool) => {
      const toolName = `mcp_${sanitizeNamePart(cfg.name)}_${sanitizeNamePart(remoteTool.name)}`.slice(0, 64);
      const readOnly = remoteTool.annotations?.readOnlyHint === true;
      return {
        spec: {
          name: toolName,
          description: `[${cfg.name} MCP server] ${remoteTool.description || remoteTool.name}`,
          parameters: remoteTool.inputSchema as Record<string, unknown>,
        },
        // Unknown MCP tools default to requiring approval, same as this app's own git/shell/PR
        // tools — only a tool the server itself annotates read-only skips that.
        requiresConfirmation: !readOnly,
        async run(args: Record<string, unknown>): Promise<string> {
          // callTool()'s return type also covers a legacy result shape without `content`; in
          // practice every server we care about here returns the standard content-block shape.
          const result = (await client.callTool({ name: remoteTool.name, arguments: args })) as {
            content?: McpContentBlock[];
            isError?: boolean;
          };
          const text = extractText(result);
          if (result.isError) throw new Error(text);
          return text;
        },
      };
    });

    return {
      tools,
      status: { name: cfg.name, connected: true, toolCount: tools.length },
      close: () => client.close(),
    };
  } catch (err) {
    return {
      tools: [],
      status: { name: cfg.name, connected: false, toolCount: 0, error: err instanceof Error ? err.message : String(err) },
      close: async () => {},
    };
  }
}

/**
 * Connects to every configured MCP server in parallel. A server that fails to connect (bad
 * command, unreachable URL, bad credential) is reported in `statuses` rather than throwing —
 * one misconfigured connector shouldn't take down the rest of the agent's tools.
 */
export async function connectMcpServers(configs: McpServerConfig[]): Promise<McpConnections> {
  if (!configs.length) return { tools: [], statuses: [], close: async () => {} };

  const results = await Promise.all(configs.map(connectOne));
  return {
    tools: results.flatMap((r) => r.tools),
    statuses: results.map((r) => r.status),
    close: async () => {
      await Promise.all(results.map((r) => r.close().catch(() => {})));
    },
  };
}
