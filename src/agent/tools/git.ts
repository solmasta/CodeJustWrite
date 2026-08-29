import { execSandboxed } from "../../sandbox/exec.js";
import type { ToolDefinition } from "./types.js";

async function git(repoRoot: string, args: string, timeoutSec = 30) {
  return execSandboxed(`git ${args}`, { cwd: repoRoot, timeoutSec });
}

export const gitStatusTool: ToolDefinition = {
  spec: {
    name: "git_status",
    description: "Show `git status --short` for the repository.",
    parameters: { type: "object", properties: {} },
  },
  async run(_args, ctx) {
    const result = await git(ctx.repoRoot, "status --short --branch");
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
    const scope = args.path ? ` -- "${String(args.path)}"` : "";
    const result = await git(ctx.repoRoot, `diff HEAD${scope}`);
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
    const result = await git(ctx.repoRoot, `checkout -b ${String(args.branch)}`);
    if (result.code !== 0) throw new Error(result.stderr || result.stdout);
    return `Switched to new branch ${args.branch}`;
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
    const paths = Array.isArray(args.paths) && args.paths.length ? (args.paths as string[]) : ["-A"];
    const addResult = await git(ctx.repoRoot, `add ${paths.map((p) => `"${p}"`).join(" ")}`);
    if (addResult.code !== 0) throw new Error(addResult.stderr || addResult.stdout);

    const message = String(args.message).replace(/"/g, '\\"');
    const commitResult = await git(ctx.repoRoot, `commit -m "${message}"`);
    if (commitResult.code !== 0) throw new Error(commitResult.stderr || commitResult.stdout);
    return commitResult.stdout;
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
    const result = await git(ctx.repoRoot, `merge --no-edit ${String(args.branch)}`);
    if (result.code !== 0) {
      throw new Error(
        `Merge failed (resolve manually, do not force):\n${result.stderr || result.stdout}`
      );
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
    const branchArg = args.branch ? String(args.branch) : null;
    const branch = branchArg ?? (await git(ctx.repoRoot, "rev-parse --abbrev-ref HEAD")).stdout.trim();
    const result = await git(ctx.repoRoot, `push -u origin ${branch}`, 60);
    if (result.code !== 0) throw new Error(result.stderr || result.stdout);
    return result.stderr || result.stdout || `Pushed ${branch} to origin`;
  },
};
