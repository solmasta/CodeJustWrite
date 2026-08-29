import type { ToolSpec } from "../../providers/types.js";
import type { CjwConfig } from "../../config/config.js";

export interface ToolContext {
  repoRoot: string;
  config: CjwConfig;
  /** Ask the human operator to confirm a risky action; resolves to their yes/no. */
  confirm: (question: string) => Promise<boolean>;
  log: (line: string) => void;
}

export interface ToolDefinition {
  spec: ToolSpec;
  /** Returns the string that gets fed back to the model as the tool result. */
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<string>;
  /** Risky tools (writes, shell exec, git mutations, PR creation) require confirmation unless auto-approved. */
  requiresConfirmation?: boolean;
}
