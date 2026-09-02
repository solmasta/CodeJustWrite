import { execSandboxed } from "../../sandbox/exec.js";
import type { ToolDefinition } from "./types.js";

async function ghCliAvailable(repoRoot: string): Promise<boolean> {
  const which = await execSandboxed("gh --version", { cwd: repoRoot, timeoutSec: 10 });
  if (which.code !== 0) return false;
  const auth = await execSandboxed("gh auth status", { cwd: repoRoot, timeoutSec: 10 });
  return auth.code === 0;
}

interface RepoSlug {
  owner: string;
  repo: string;
}

async function parseOriginSlug(repoRoot: string): Promise<RepoSlug> {
  const result = await execSandboxed("git remote get-url origin", { cwd: repoRoot, timeoutSec: 10 });
  if (result.code !== 0) throw new Error("No 'origin' remote configured.");
  const url = result.stdout.trim();
  // Handles both git@github.com:owner/repo.git and https://github.com/owner/repo(.git)
  const match = url.match(/github\.com[:/]([^/]+)\/(.+?)(\.git)?$/);
  if (!match) throw new Error(`Could not parse a GitHub owner/repo from origin URL: ${url}`);
  return { owner: match[1], repo: match[2] };
}

async function currentBranch(repoRoot: string): Promise<string> {
  return (
    await execSandboxed("git rev-parse --abbrev-ref HEAD", { cwd: repoRoot, timeoutSec: 10 })
  ).stdout.trim();
}

async function findOpenPrNumber(owner: string, repo: string, token: string, branch: string): Promise<number> {
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/pulls?head=${owner}:${encodeURIComponent(branch)}&state=open`,
    { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" } }
  );
  const data = (await res.json()) as Array<{ number: number }> | { message?: string };
  if (!res.ok || !Array.isArray(data)) {
    throw new Error(
      `GitHub REST API error (${res.status}): ${(data as { message?: string }).message ?? JSON.stringify(data)}`
    );
  }
  if (data.length === 0) throw new Error(`No open PR found for branch '${branch}'.`);
  return data[0].number;
}

async function createPrViaRest(
  repoRoot: string,
  token: string,
  title: string,
  body: string,
  head: string,
  base: string
): Promise<string> {
  const { owner, repo } = await parseOriginSlug(repoRoot);
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ title, body, head, base }),
  });
  const data = (await res.json()) as { html_url?: string; message?: string; errors?: unknown };
  if (!res.ok) {
    throw new Error(`GitHub REST API error (${res.status}): ${data.message ?? JSON.stringify(data)}`);
  }
  return data.html_url ?? "PR created (no URL returned).";
}

export const createPullRequestTool: ToolDefinition = {
  spec: {
    name: "create_pull_request",
    description:
      "Open a pull request from the current branch. Uses the `gh` CLI if installed and authenticated, otherwise falls back to the GitHub REST API using GITHUB_TOKEN.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "PR title." },
        body: { type: "string", description: "PR description body." },
        base: { type: "string", description: "Base branch to merge into. Defaults to the repo's default branch." },
        head: { type: "string", description: "Head branch. Defaults to the current branch." },
      },
      required: ["title", "body"],
    },
  },
  requiresConfirmation: true,
  async run(args, ctx) {
    const title = String(args.title);
    const body = String(args.body);
    const head =
      args.head != null
        ? String(args.head)
        : (await execSandboxed("git rev-parse --abbrev-ref HEAD", { cwd: ctx.repoRoot, timeoutSec: 10 })).stdout.trim();

    if (await ghCliAvailable(ctx.repoRoot)) {
      const baseFlag = args.base ? ` --base ${String(args.base)}` : "";
      const escapedTitle = title.replace(/"/g, '\\"');
      const escapedBody = body.replace(/"/g, '\\"');
      const result = await execSandboxed(
        `gh pr create --title "${escapedTitle}" --body "${escapedBody}" --head ${head}${baseFlag}`,
        { cwd: ctx.repoRoot, timeoutSec: 30 }
      );
      if (result.code !== 0) throw new Error(result.stderr || result.stdout);
      return result.stdout.trim();
    }

    if (!ctx.config.githubToken) {
      throw new Error(
        "The `gh` CLI isn't installed/authenticated and GITHUB_TOKEN isn't set — can't create a PR either way."
      );
    }
    const base =
      args.base != null
        ? String(args.base)
        : (
            await execSandboxed("git remote show origin | sed -n '/HEAD branch/s/.*: //p'", {
              cwd: ctx.repoRoot,
              timeoutSec: 15,
            })
          ).stdout.trim() || "main";
    return createPrViaRest(ctx.repoRoot, ctx.config.githubToken, title, body, head, base);
  },
};

export const mergePullRequestTool: ToolDefinition = {
  spec: {
    name: "merge_pull_request",
    description:
      "Merge an open pull request. Identify it by pullNumber, or by branch (defaults to the current " +
      "branch's PR). Uses the `gh` CLI if installed and authenticated, otherwise the GitHub REST API " +
      "using GITHUB_TOKEN.",
    parameters: {
      type: "object",
      properties: {
        pullNumber: { type: "number", description: "PR number. Omit to look up by branch." },
        branch: { type: "string", description: "Head branch of the PR. Defaults to the current branch." },
        mergeMethod: {
          type: "string",
          enum: ["merge", "squash", "rebase"],
          description: "Defaults to 'squash'.",
        },
      },
    },
  },
  requiresConfirmation: true,
  async run(args, ctx) {
    const mergeMethod = (
      ["merge", "squash", "rebase"].includes(String(args.mergeMethod)) ? String(args.mergeMethod) : "squash"
    ) as "merge" | "squash" | "rebase";
    const ref =
      args.pullNumber != null
        ? String(args.pullNumber)
        : args.branch != null
          ? String(args.branch)
          : await currentBranch(ctx.repoRoot);

    if (await ghCliAvailable(ctx.repoRoot)) {
      const result = await execSandboxed(`gh pr merge ${ref} --${mergeMethod} --delete-branch=false`, {
        cwd: ctx.repoRoot,
        timeoutSec: 30,
      });
      if (result.code !== 0) throw new Error(result.stderr || result.stdout);
      return result.stdout.trim() || `Merged ${ref} (${mergeMethod}).`;
    }

    if (!ctx.config.githubToken) {
      throw new Error(
        "The `gh` CLI isn't installed/authenticated and GITHUB_TOKEN isn't set — can't merge a PR either way."
      );
    }
    const { owner, repo } = await parseOriginSlug(ctx.repoRoot);
    const pullNumber =
      args.pullNumber != null ? Number(args.pullNumber) : await findOpenPrNumber(owner, repo, ctx.config.githubToken, ref);
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${pullNumber}/merge`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${ctx.config.githubToken}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ merge_method: mergeMethod }),
    });
    const data = (await res.json()) as { merged?: boolean; message?: string; sha?: string };
    if (!res.ok || !data.merged) {
      throw new Error(`GitHub REST API error (${res.status}): ${data.message ?? JSON.stringify(data)}`);
    }
    return `Merged PR #${pullNumber} (${mergeMethod}${data.sha ? `, commit ${data.sha}` : ""}).`;
  },
};

export const getPullRequestStatusTool: ToolDefinition = {
  spec: {
    name: "get_pull_request_status",
    description:
      "Check a pull request's mergeability and CI status — open/closed/merged state, whether it has merge " +
      "conflicts, and each check run's name/status/conclusion. Identify it by pullNumber, or by branch " +
      "(defaults to the current branch's PR). Use this to decide whether a PR is ready to merge or needs " +
      "a fix pushed first.",
    parameters: {
      type: "object",
      properties: {
        pullNumber: { type: "number", description: "PR number. Omit to look up by branch." },
        branch: { type: "string", description: "Head branch of the PR. Defaults to the current branch." },
      },
    },
  },
  requiresConfirmation: false,
  async run(args, ctx) {
    const ref =
      args.pullNumber != null
        ? String(args.pullNumber)
        : args.branch != null
          ? String(args.branch)
          : await currentBranch(ctx.repoRoot);

    if (await ghCliAvailable(ctx.repoRoot)) {
      const result = await execSandboxed(
        `gh pr view ${ref} --json number,state,mergeable,mergeStateStatus,statusCheckRollup,url`,
        { cwd: ctx.repoRoot, timeoutSec: 30 }
      );
      if (result.code !== 0) throw new Error(result.stderr || result.stdout);
      return result.stdout.trim();
    }

    if (!ctx.config.githubToken) {
      throw new Error(
        "The `gh` CLI isn't installed/authenticated and GITHUB_TOKEN isn't set — can't check PR status either way."
      );
    }
    const { owner, repo } = await parseOriginSlug(ctx.repoRoot);
    const pullNumber =
      args.pullNumber != null ? Number(args.pullNumber) : await findOpenPrNumber(owner, repo, ctx.config.githubToken, ref);
    const prRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${pullNumber}`, {
      headers: { Authorization: `Bearer ${ctx.config.githubToken}`, Accept: "application/vnd.github+json" },
    });
    const pr = (await prRes.json()) as {
      number: number;
      state?: string;
      mergeable?: boolean | null;
      mergeable_state?: string;
      html_url?: string;
      head?: { sha?: string };
      message?: string;
    };
    if (!prRes.ok) throw new Error(`GitHub REST API error (${prRes.status}): ${pr.message ?? JSON.stringify(pr)}`);

    const sha = pr.head?.sha;
    let checksSummary = "(no head sha to check)";
    if (sha) {
      const checksRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/commits/${sha}/check-runs`, {
        headers: { Authorization: `Bearer ${ctx.config.githubToken}`, Accept: "application/vnd.github+json" },
      });
      const checksData = (await checksRes.json()) as {
        check_runs?: Array<{ name: string; status: string; conclusion: string | null }>;
      };
      const runs = checksData.check_runs ?? [];
      checksSummary = runs.length
        ? runs.map((r) => `${r.name}: ${r.status}${r.conclusion ? ` (${r.conclusion})` : ""}`).join("\n")
        : "(no check runs found)";
    }

    return [
      `PR #${pr.number} — state: ${pr.state}, mergeable: ${pr.mergeable ?? "unknown"} (${pr.mergeable_state ?? "unknown"})`,
      pr.html_url ?? "",
      "Checks:",
      checksSummary,
    ]
      .filter(Boolean)
      .join("\n");
  },
};
