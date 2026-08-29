export { Agent } from "./agent/agent.js";
export type { AgentDeps } from "./agent/agent.js";
export { SYSTEM_PROMPT } from "./agent/systemPrompt.js";
export { allTools, toolsByName } from "./agent/tools/index.js";
export type { ToolDefinition, ToolContext } from "./agent/tools/index.js";

export { ProviderRegistry } from "./providers/registry.js";
export type {
  ChatMessage,
  LLMProvider,
  ToolCall,
  ToolSpec,
  CompletionResult,
  StreamHandlers,
} from "./providers/types.js";

export { loadConfig, defaultModelFor } from "./config/config.js";
export type { CjwConfig, ProviderName } from "./config/config.js";

export { execSandboxed } from "./sandbox/exec.js";
export type { ExecResult, ExecOptions } from "./sandbox/exec.js";
export { createTestWorktree } from "./sandbox/workspace.js";
export type { Worktree } from "./sandbox/workspace.js";

export { log } from "./utils/logger.js";
