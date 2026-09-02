import type { ToolSpec } from "../../providers/types.js";
import type { CjwConfig } from "../../config/config.js";

export interface ToolContext {
  repoRoot: string;
  config: CjwConfig;
  /** Ask the human operator to confirm a risky action; resolves to their yes/no. */
  confirm: (question: string) => Promise<boolean>;
  log: (line: string) => void;
}

export interface ToolResult {
  /** Fed back to the model as the tool result, same as a plain string return. */
  text: string;
  /** Base64 data URLs (e.g. "data:image/png;base64,...") to show the model as a follow-up
   *  multimodal message — e.g. a browser_check screenshot. The OpenAI-compatible wire format
   *  can't carry images on a tool-role message, so these ride along as a separate turn instead.
   *  Only vision-capable models actually see them; other models just ignore/error on the extra
   *  turn depending on the provider, same as any other model/feature mismatch. */
  images?: string[];
}

export interface ToolDefinition {
  spec: ToolSpec;
  /** Returns either the plain tool-result string, or a ToolResult when there's an image to attach. */
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<string | ToolResult>;
  /** Risky tools (writes, shell exec, git mutations, PR creation) require confirmation unless auto-approved. */
  requiresConfirmation?: boolean;
  /** No side effects and no ordering dependency on any other tool call — safe to run concurrently
   *  with other readOnly calls from the same model turn (e.g. several read_file/search_files
   *  calls at once). Leave unset/false for anything that mutates state or shares a resource
   *  (worktrees, the browser process, git refs) where a race could cause real damage; when in
   *  doubt, leave it false — the fallback is always safe, just serial. */
  readOnly?: boolean;
  /** Doesn't require confirmation, and works against its own private resource (a temp git
   *  worktree, a fresh browser instance) rather than the live working tree — safe to run
   *  alongside readOnly calls from the same turn (at most one isolatedResource call per batch,
   *  to avoid piling up e.g. two concurrent npm installs). Never combine with
   *  requiresConfirmation: true — see the note on Agent.executeToolCalls for why. */
  isolatedResource?: boolean;
}
