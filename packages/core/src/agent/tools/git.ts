import { execSandboxed } from "../../sandbox/exec.js";
import type { ToolDefinition } from "./types.js";

interface GitResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

async function git(repoRoot: string, args: string[], timeoutSec = 30): Promise<GitResult> {
  // Use array form to avoid shell interpretation entirely
  return execSandboxed("git", args, { cwd: repoRoot, timeoutSec });
}

function sanitizeBranch(name: string): string {
  // Strict branch name validation: alphanumeric, dots, hyphens, underscores, slashes
  const sanitized = name.replace(/[^a-zA-Z0-9._/-]/g, "");
  // Reject branch names that look like paths or refs
  if (sanitized.startsWith("/") || sanitized.startsWith("-") || sanitized.includes("..")) {
    return "";
  }
  return sanitized;
}

function validatePath(path: string): string {
  // Reject paths with shell metacharacters
  if (/[;&|`$(){}[\]<>!#*?~\n\r]/.test(path)) {
    throw new Error("Path contains invalid characters");
  }
  // Normalize and return
  return path.replace(/"/g, "");
}

function checkGitSuccess(result: GitResult): void {
  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout);
  }
}

export const gitStatusTool: ToolDefinition = {
  spec: {
    name: "git_status",
    description: "Show `git status --short --branch` for the repository.",
    parameters: { type: "object", properties: {} },
  },
  async run(_args, ctx) {
    const result = await git(ctx.repoRoot, ["status", "--short", "--branch"]);
    return result.stdout || "(clean)";
  },
};

export const gitDiffTool: ToolDefinition = {
  spec: {
    name: "git_diff",
    description: "Show the working-tree diff (git diff HEAD). Optionally scoped to one path.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Optional path to scope the diff to." },
      },
    },
  },
  async run(args, ctx) {
    const gitArgs = ["diff", "HEAD"];
    if (args.path) {
      const safePath = validatePath(String(args.path));
      gitArgs.push("--", safePath);
    }
    const result = await git(ctx.repoRoot, gitArgs);
    return result.stdout || "(no changes)";
  },
};

export const gitCreateBranchTool: ToolDefinition = {
  spec: {
    name: "git_create_branch",
    description: "Create and switch to a new git branch.",
    parameters: {
      type: "object",
      properties: {
        branch: { type: "string", description: "Name of the new branch." },
      },
      required: ["branch"],
    },
  },
  requiresConfirmation: true,
  async run(args, ctx) {
    const branch = sanitizeBranch(String(args.branch));
    if (!branch) throw new Error("Invalid branch name");
    const result = await git(ctx.repoRoot, ["checkout", "-b", branch]);
    checkGitSuccess(result);
    return `Switched to new branch ${branch}`;
  },
};

export const gitCommitTool: ToolDefinition = {
  spec: {
    name: "git_commit",
    description: "Stage the given paths (or all changes) and create a commit with the given message.",
    parameters: {
      type: "object",
      properties: {
        message: { type: "string", description: "Commit message." },
        paths: {
          type: "array",
          items: { type: "string" },
          description: "Paths to stage. Omit or pass [] to stage all changes (git add -A).",
        },
      },
      required: ["message"],
    },
  },
  requiresConfirmation: true,
  async run(args, ctx) {
    // Stage changes
    const paths = Array.isArray(args.paths) && args.paths.length ? args.paths as string[] : ["-A"];
    if (paths[0] === "-A") {
      const addResult = await git(ctx.repoRoot, ["add", "-A"]);
      checkGitSuccess(addResult);
    } else {
      for (const p of paths) {
        const safePath = validatePath(String(p));
        const addResult = await git(ctx.repoRoot, ["add", "--", safePath]);
        checkGitSuccess(addResult);
      }
    }

    // Commit with message via file to avoid shell escaping issues
    const message = String(args.message).replace(/\r?\n/g, "\n");
    const result = await git(ctx.repoRoot, ["commit", "-m", message]);
    checkGitSuccess(result);
    return result.stdout;
  },
};

export const gitMergeTool: ToolDefinition = {
  spec: {
    name: "git_merge",
    description: "Merge the given branch into the current branch.",
    parameters: {
      type: "object",
      properties: {
        branch: { type: "string", description: "Branch to merge into the current branch." },
      },
      required: ["branch"],
    },
  },
  requiresConfirmation: true,
  async run(args, ctx) {
    const branch = sanitizeBranch(String(args.branch));
    if (!branch) throw new Error("Invalid branch name");
    const result = await git(ctx.repoRoot, ["merge", "--no-edit", branch]);
    if (result.code !== 0) {
      throw new Error(`Merge failed (resolve manually, do not force):\n${result.stderr || result.stdout}`);
    }
    return result.stdout;
  },
};

export const gitPushTool: ToolDefinition = {
  spec: {
    name: "git_push",
    description: "Push the current branch to origin, setting upstream if needed.",
    parameters: {
      type: "object",
      properties: {
        branch: { type: "string", description: "Branch to push. Defaults to the current branch." },
      },
    },
  },
  requiresConfirmation: true,
  async run(args, ctx) {
    const branchArg = args.branch ? sanitizeBranch(String(args.branch)) : null;
    if (branchArg === "") throw new Error("Invalid branch name");

    let branch: string;
    if (branchArg) {
      branch = branchArg;
    } else {
      const result = await git(ctx.repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
      branch = result.stdout.trim();
    }
    
    const result = await git(ctx.repoRoot, ["push", "-u", "origin", branch], 60);
    checkGitSuccess(result);
    return result.stderr || result.stdout || `Pushed ${branch} to origin`;
  },
};