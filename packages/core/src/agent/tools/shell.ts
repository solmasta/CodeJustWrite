import { execSandboxed } from "../../sandbox/exec.js";
import type { ToolDefinition } from "./types.js";

const ALLOWED_COMMANDS = new Set([
  "npm", "yarn", "pnpm", "bun", "node", "npx",
  "git", "ls", "cat", "find", "grep", "echo",
  "make", "mkdir", "touch", "cp", "mv", "rm",
  "head", "tail", "wc", "sort", "uniq", "diff",
  "pwd", "cd", "clear", "which", "type",
]);

const BLOCKED_PATTERNS = [
  /rm\s+-rf/i, /chmod/i, /sudo/i, /su\s/i,
  /wget/i, /curl.*-O/i, /curl.*--output/i,
  /sh\s+-c/i, /bash\s+-c/i, /:\s*[\w]/,
  /\|\s*sh/i, /\|\s*bash/i, /\|\s*\(/i,
  /\$\(/i, /`/i, /\}\s*;/i, /;\s*rm/i,
  /\.\./i, /~\//i, /\/etc\//i, /\/root\//i,
  />/i, /\|/i, /&&/, /\|\|/, /;/,
];

function validateCommand(command: string, repoRoot: string): string | null {
  const trimmed = command.trim();
  const parts = trimmed.split(/\s+/);
  const baseCmd = parts[0];

  if (!ALLOWED_COMMANDS.has(baseCmd)) {
    return `Command '${baseCmd}' not allowed. Allowed: ${[...ALLOWED_COMMANDS].join(", ")}`;
  }

  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(trimmed)) {
      return `Command contains blocked pattern: ${pattern}`;
    }
  }

  const args = parts.slice(1).join(" ");
  if (args.includes("..") || args.includes("/etc") || args.includes("/root")) {
    return "Path traversal detected";
  }

  if (trimmed.length > 1000) {
    return "Command too long (max 1000 chars)";
  }

  return null;
}

export const runShellTool: ToolDefinition = {
  spec: {
    name: "run_shell",
    description:
      "Run a shell command in the repository root, sandboxed with a wall-clock timeout and truncated output. Use for installs, builds, one-off scripts. Prefer run_tests for the project's test suite.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The shell command to run." },
      },
      required: ["command"],
    },
  },
  requiresConfirmation: true,
  async run(args, ctx) {
    const command = String(args.command);
    const error = validateCommand(command, ctx.repoRoot);
    
    if (error) {
      return { error };
    }

    const result = await execSandboxed(command, {
      cwd: ctx.repoRoot,
      timeoutSec: ctx.config.shellTimeoutSec,
    });

    const status = result.timedOut
      ? `TIMED OUT after ${ctx.config.shellTimeoutSec}s`
      : `exit code ${result.code}`;

    return [
      `$ ${args.command}`,
      `(${status})`,
      "--- stdout ---",
      result.stdout,
      "--- stderr ---",
      result.stderr,
    ]
      .join("\n");
  },
};