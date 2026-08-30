import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ToolContext } from "../src/agent/tools/index.js";
import type { CjwConfig } from "../src/config/config.js";

export function makeConfig(overrides: Partial<CjwConfig> = {}): CjwConfig {
  return {
    provider: "deepinfra",
    model: "meta-llama/Meta-Llama-3.1-70B-Instruct",
    shellTimeoutSec: 30,
    mcpServers: [],
    ...overrides,
  };
}

export function makeCtx(repoRoot: string, overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    repoRoot,
    config: makeConfig(),
    confirm: async () => true,
    log: () => {},
    ...overrides,
  };
}

export function tempDir(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}
