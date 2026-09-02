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
  // Strict branch name validation: alphanumeric, dots, hyphens, underscores, slashes.
  // Reject anything containing a disallowed character instead of silently
  // stripping it — stripping would let a mistyped or adversarial name
  // silently resolve to a different, unintended branch.
  if (!/^[a-zA-Z0-9._/-]+$/.test(name)) return "";
  // Reject branch names that look like paths or refs
  if (name.startsWith("/") || name.startsWith("-") || name.includes("..")) {
    return "";
  }
  return name;
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

export const gitLogTool: ToolDefinition = {
  spec: {
    name: "git_log",
    description: "Show recent commit history (hash, date, author, subject) for the current branch, or one path.",
    parameters: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max commits to show. Defaults to 20." },
        path: { type: "string", description: "Optional path to scope the log to." },
      },
    },
  },
  async run(args, ctx) {
    const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 200);
    const gitArgs = ["log", `-n`, String(limit), "--date=short", "--pretty=format:%h  %ad  %an  %s"];
    if (args.path) {
      const safePath = validatePath(String(args.path));
      gitArgs.push("--", safePath);
    }
    const result = await git(ctx.repoRoot, gitArgs);
    checkGitSuccess(result);
    return result.stdout || "(no commits)";
  },
};

export const gitStashTool: ToolDefinition = {
  spec: {
    name: "git_stash",
    description: "Stash the current uncommitted changes (working tree + staged), leaving a clean tree.",
    parameters: {
      type: "object",
      properties: {
        message: { type: "string", description: "Optional label for the stash entry." },
      },
    },
  },
  requiresConfirmation: true,
  async run(args, ctx) {
    const gitArgs = ["stash", "push", "-u"];
    if (args.message) gitArgs.push("-m", String(args.message));
    const result = await git(ctx.repoRoot, gitArgs);
    checkGitSuccess(result);
    return result.stdout || result.stderr || "Stashed.";
  },
};

export const gitStashPopTool: ToolDefinition = {
  spec: {
    name: "git_stash_pop",
    description: "Re-apply the most recent stash entry to the working tree and drop it from the stash list.",
    parameters: { type: "object", properties: {} },
  },
  requiresConfirmation: true,
  async run(_args, ctx) {
    const result = await git(ctx.repoRoot, ["stash", "pop"]);
    checkGitSuccess(result);
    return result.stdout || result.stderr || "Stash popped.";
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

export const gitFetchTool: ToolDefinition = {
  spec: {
    name: "git_fetch",
    description:
      "Fetch a branch from origin so it can be checked out or merged. Sessions may start with only " +
      "one branch present locally, so call this before git_checkout or git_merge on any branch that " +
      "isn't already local (git_status/git_diff won't show a branch that hasn't been fetched yet).",
    parameters: {
      type: "object",
      properties: {
        branch: { type: "string", description: "Branch to fetch from origin." },
      },
      required: ["branch"],
    },
  },
  async run(args, ctx) {
    const branch = sanitizeBranch(String(args.branch));
    if (!branch) throw new Error("Invalid branch name");
    // Fetch with an explicit destination refspec: a single-branch clone
    // narrows the repo's configured remote.origin.fetch refspec to just the
    // branch it was cloned with, so a plain `git fetch origin <branch>`
    // would land only in FETCH_HEAD and never create the origin/<branch>
    // tracking ref that git_checkout/git_merge need.
    const result = await git(
      ctx.repoRoot,
      ["fetch", "origin", `${branch}:refs/remotes/origin/${branch}`],
      60
    );
    checkGitSuccess(result);
    return result.stderr || result.stdout || `Fetched origin/${branch}`;
  },
};

export const gitCheckoutTool: ToolDefinition = {
  spec: {
    name: "git_checkout",
    description:
      "Switch the working tree to an existing branch (a local branch, or a fetched origin/<branch> — " +
      "run git_fetch first if it isn't local yet). Use this to get back to the base branch before " +
      "merging a feature branch into it; git_create_branch only ever creates a new branch.",
    parameters: {
      type: "object",
      properties: {
        branch: { type: "string", description: "Branch to switch to." },
      },
      required: ["branch"],
    },
  },
  requiresConfirmation: true,
  async run(args, ctx) {
    const branch = sanitizeBranch(String(args.branch));
    if (!branch) throw new Error("Invalid branch name");

    const localRef = await git(ctx.repoRoot, ["rev-parse", "-q", "--verify", `refs/heads/${branch}`]);
    if (localRef.code === 0) {
      const result = await git(ctx.repoRoot, ["checkout", branch]);
      checkGitSuccess(result);
      return `Switched to branch ${branch}`;
    }

    const remoteRef = await git(ctx.repoRoot, ["rev-parse", "-q", "--verify", `refs/remotes/origin/${branch}`]);
    if (remoteRef.code === 0) {
      // Not --track: a single-branch clone's remote.origin.fetch refspec
      // only matches the branch it was cloned with, so git doesn't
      // recognize a ref git_fetch created for any other branch as an
      // eligible tracking target and --track fails with "is not a branch"
      // even though the ref itself resolves fine.
      const result = await git(ctx.repoRoot, ["checkout", "-b", branch, `origin/${branch}`]);
      checkGitSuccess(result);
      return `Switched to new branch ${branch} (from origin/${branch})`;
    }

    throw new Error(
      `Branch '${branch}' not found locally or as origin/${branch}. Call git_fetch with this branch name first.`
    );
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

    // Passed as a single argv element (no shell involved), so multi-line
    // messages and special characters need no escaping.
    const message = String(args.message).replace(/\r?\n/g, "\n");
    const result = await git(ctx.repoRoot, ["commit", "-m", message]);
    checkGitSuccess(result);
    return result.stdout;
  },
};

export const gitMergeTool: ToolDefinition = {
  spec: {
    name: "git_merge",
    description:
      "Merge the given branch into the current branch. The branch must already be local or fetched " +
      "(git_fetch) and you must already be on the target branch (git_checkout) — merge merges INTO " +
      "the current branch, it does not switch to one. Automatically deepens a shallow clone's " +
      "history and retries once if the two branches only look unrelated due to that.",
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
    let result = await git(ctx.repoRoot, ["merge", "--no-edit", branch]);

    // Sessions clone shallowly (see apps/server/src/session.ts), so merging any branch whose
    // real common ancestor with the current branch falls outside that shallow window fails here
    // even though the two branches aren't actually unrelated — only their fetched history is
    // truncated. Fill in full history once, on demand, and retry exactly once.
    if (result.code !== 0 && /unrelated histories/i.test(result.stderr || result.stdout)) {
      const isShallow = await git(ctx.repoRoot, ["rev-parse", "--is-shallow-repository"]);
      if (isShallow.stdout.trim() === "true") {
        const unshallow = await git(ctx.repoRoot, ["fetch", "--unshallow", "origin"], 300);
        if (unshallow.code === 0) {
          result = await git(ctx.repoRoot, ["merge", "--no-edit", branch]);
        }
      }
    }

    if (result.code !== 0) {
      const output = result.stderr || result.stdout;
      const mergeHead = await git(ctx.repoRoot, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]);
      if (mergeHead.code === 0) {
        // A real conflict: git leaves the working tree mid-merge (conflict
        // markers written, MERGE_HEAD set) so it can be resolved in place —
        // do not force through it. Spell out both ways to leave that state,
        // since the model has no other way to learn this convention.
        throw new Error(
          `Merge conflict, working tree left mid-merge (do not force):\n${output}\n\n` +
            "To resolve: fix the conflict markers in the listed files with edit_file, then call " +
            "git_commit to record the merge. To give up instead, call git_merge_abort to restore " +
            "the pre-merge state."
        );
      }
      throw new Error(`Merge failed:\n${output}`);
    }
    return result.stdout;
  },
};

export const gitMergeAbortTool: ToolDefinition = {
  spec: {
    name: "git_merge_abort",
    description:
      "Abort an in-progress merge left by a conflicting git_merge, restoring the working tree to its " +
      "pre-merge state. Only valid right after a git_merge conflict.",
    parameters: { type: "object", properties: {} },
  },
  requiresConfirmation: true,
  async run(_args, ctx) {
    const result = await git(ctx.repoRoot, ["merge", "--abort"]);
    checkGitSuccess(result);
    return "Merge aborted; working tree restored to its pre-merge state.";
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