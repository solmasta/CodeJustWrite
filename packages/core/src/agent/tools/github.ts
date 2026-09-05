import { execSandboxed } from "../../sandbox/exec.js";
import type { ToolContext, ToolDefinition } from "./types.js";

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
  readOnly: true,
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

// --- Issues, review comments, code search ---
//
// Everything below always talks to the REST API directly with GITHUB_TOKEN — unlike the tools
// above, there's no `gh` CLI fallback, since none of this (issues, inline review comments, code
// search) is something the agent needs when the CLI isn't available; it's already a step beyond
// this app's core git workflow.

function requireToken(ctx: ToolContext): string {
  if (!ctx.config.githubToken) throw new Error("GITHUB_TOKEN isn't configured on this server.");
  return ctx.config.githubToken;
}

async function resolveRepoSlug(args: Record<string, unknown>, ctx: ToolContext): Promise<RepoSlug> {
  if (typeof args.owner === "string" && args.owner && typeof args.repo === "string" && args.repo) {
    return { owner: args.owner, repo: args.repo };
  }
  return parseOriginSlug(ctx.repoRoot);
}

async function githubFetch(path: string, token: string, init?: { method?: string; body?: unknown }): Promise<unknown> {
  const res = await fetch(`https://api.github.com${path}`, {
    method: init?.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
    },
    body: init?.body ? JSON.stringify(init.body) : undefined,
  });
  const data = (await res.json().catch(() => undefined)) as unknown;
  if (!res.ok) {
    const message = data && typeof data === "object" && "message" in data ? (data as { message: unknown }).message : data;
    throw new Error(`GitHub REST API error (${res.status}): ${typeof message === "string" ? message : JSON.stringify(message)}`);
  }
  return data;
}

interface GithubIssue {
  number: number;
  title: string;
  state: string;
  html_url?: string;
  pull_request?: unknown;
  labels?: Array<{ name: string } | string>;
}

export const listIssuesTool: ToolDefinition = {
  spec: {
    name: "github_list_issues",
    description: "List issues in a GitHub repo (excludes pull requests, which GitHub's API otherwise mixes in).",
    parameters: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Repo owner. Defaults to the current repo's origin." },
        repo: { type: "string", description: "Repo name. Defaults to the current repo's origin." },
        state: { type: "string", enum: ["open", "closed", "all"], description: "Defaults to open." },
        labels: { type: "string", description: "Comma-separated label names to filter by." },
        limit: { type: "number", description: "Max issues to return. Defaults to 20." },
      },
    },
  },
  requiresConfirmation: false,
  readOnly: true,
  async run(args, ctx) {
    const token = requireToken(ctx);
    const { owner, repo } = await resolveRepoSlug(args, ctx);
    const state = typeof args.state === "string" ? args.state : "open";
    const limit = typeof args.limit === "number" && args.limit > 0 ? Math.min(args.limit, 100) : 20;
    const params = new URLSearchParams({ state, per_page: String(limit) });
    if (typeof args.labels === "string" && args.labels) params.set("labels", args.labels);
    const data = (await githubFetch(`/repos/${owner}/${repo}/issues?${params}`, token)) as GithubIssue[];
    const issuesOnly = data.filter((i) => !i.pull_request);
    if (!issuesOnly.length) return "(no issues found)";
    return issuesOnly
      .map((i) => {
        const labels = (i.labels ?? []).map((l) => (typeof l === "string" ? l : l.name)).join(", ");
        return `#${i.number} [${i.state}] ${i.title}${labels ? ` (${labels})` : ""}`;
      })
      .join("\n");
  },
};

export const createIssueTool: ToolDefinition = {
  spec: {
    name: "github_create_issue",
    description: "Open a new issue in a GitHub repo.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Issue title." },
        body: { type: "string", description: "Issue body." },
        labels: { type: "string", description: "Comma-separated label names to apply." },
        owner: { type: "string", description: "Repo owner. Defaults to the current repo's origin." },
        repo: { type: "string", description: "Repo name. Defaults to the current repo's origin." },
      },
      required: ["title"],
    },
  },
  requiresConfirmation: true,
  async run(args, ctx) {
    const token = requireToken(ctx);
    const { owner, repo } = await resolveRepoSlug(args, ctx);
    const labels = typeof args.labels === "string" && args.labels ? args.labels.split(",").map((l) => l.trim()) : undefined;
    const data = (await githubFetch(`/repos/${owner}/${repo}/issues`, token, {
      method: "POST",
      body: { title: String(args.title), body: typeof args.body === "string" ? args.body : undefined, labels },
    })) as { number: number; html_url?: string };
    return `Opened issue #${data.number}${data.html_url ? ` — ${data.html_url}` : ""}`;
  },
};

export const commentOnIssueTool: ToolDefinition = {
  spec: {
    name: "github_comment_on_issue",
    description: "Post a comment on an issue or pull request (PRs are issues in GitHub's data model, so this works on both).",
    parameters: {
      type: "object",
      properties: {
        issueNumber: { type: "number", description: "Issue or PR number." },
        body: { type: "string", description: "Comment text." },
        owner: { type: "string", description: "Repo owner. Defaults to the current repo's origin." },
        repo: { type: "string", description: "Repo name. Defaults to the current repo's origin." },
      },
      required: ["issueNumber", "body"],
    },
  },
  requiresConfirmation: true,
  async run(args, ctx) {
    const token = requireToken(ctx);
    const { owner, repo } = await resolveRepoSlug(args, ctx);
    const data = (await githubFetch(`/repos/${owner}/${repo}/issues/${Number(args.issueNumber)}/comments`, token, {
      method: "POST",
      body: { body: String(args.body) },
    })) as { html_url?: string };
    return `Comment posted${data.html_url ? ` — ${data.html_url}` : ""}`;
  },
};

interface ReviewComment {
  id: number;
  path: string;
  line?: number;
  body: string;
  user?: { login?: string };
  html_url?: string;
}

export const listReviewCommentsTool: ToolDefinition = {
  spec: {
    name: "github_list_review_comments",
    description: "List inline review comments on a pull request's diff (not the PR's top-level issue comments).",
    parameters: {
      type: "object",
      properties: {
        pullNumber: { type: "number", description: "PR number." },
        owner: { type: "string", description: "Repo owner. Defaults to the current repo's origin." },
        repo: { type: "string", description: "Repo name. Defaults to the current repo's origin." },
      },
      required: ["pullNumber"],
    },
  },
  requiresConfirmation: false,
  readOnly: true,
  async run(args, ctx) {
    const token = requireToken(ctx);
    const { owner, repo } = await resolveRepoSlug(args, ctx);
    const data = (await githubFetch(
      `/repos/${owner}/${repo}/pulls/${Number(args.pullNumber)}/comments`,
      token
    )) as ReviewComment[];
    if (!data.length) return "(no review comments)";
    return data
      .map((c) => `${c.path}:${c.line ?? "?"} — ${c.user?.login ?? "unknown"}: ${c.body}`)
      .join("\n");
  },
};

export const postReviewCommentTool: ToolDefinition = {
  spec: {
    name: "github_post_review_comment",
    description: "Post an inline review comment on a specific line of a pull request's diff.",
    parameters: {
      type: "object",
      properties: {
        pullNumber: { type: "number", description: "PR number." },
        path: { type: "string", description: "File path (as it appears in the diff) to comment on." },
        line: { type: "number", description: "Line number in the file's current (RIGHT) version, unless side is LEFT." },
        side: { type: "string", enum: ["LEFT", "RIGHT"], description: "Defaults to RIGHT (the new version of the line)." },
        body: { type: "string", description: "Comment text." },
        owner: { type: "string", description: "Repo owner. Defaults to the current repo's origin." },
        repo: { type: "string", description: "Repo name. Defaults to the current repo's origin." },
      },
      required: ["pullNumber", "path", "line", "body"],
    },
  },
  requiresConfirmation: true,
  async run(args, ctx) {
    const token = requireToken(ctx);
    const { owner, repo } = await resolveRepoSlug(args, ctx);
    const pullNumber = Number(args.pullNumber);
    const pr = (await githubFetch(`/repos/${owner}/${repo}/pulls/${pullNumber}`, token)) as {
      head?: { sha?: string };
    };
    if (!pr.head?.sha) throw new Error(`Could not resolve a head commit for PR #${pullNumber}.`);
    const data = (await githubFetch(`/repos/${owner}/${repo}/pulls/${pullNumber}/comments`, token, {
      method: "POST",
      body: {
        body: String(args.body),
        commit_id: pr.head.sha,
        path: String(args.path),
        line: Number(args.line),
        side: typeof args.side === "string" ? args.side : "RIGHT",
      },
    })) as { html_url?: string };
    return `Review comment posted${data.html_url ? ` — ${data.html_url}` : ""}`;
  },
};

interface CodeSearchItem {
  path: string;
  repository?: { full_name?: string };
  html_url?: string;
  text_matches?: Array<{ fragment?: string }>;
}

export const searchCodeTool: ToolDefinition = {
  spec: {
    name: "github_search_code",
    description:
      "Search code across GitHub (not limited to the currently cloned repo) using GitHub's code search " +
      "query syntax, e.g. \"useEffect repo:facebook/react\" or \"error TS2345 language:typescript\".",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "GitHub code search query." },
        limit: { type: "number", description: "Max results to return. Defaults to 10." },
      },
      required: ["query"],
    },
  },
  requiresConfirmation: false,
  readOnly: true,
  async run(args, ctx) {
    const token = requireToken(ctx);
    const limit = typeof args.limit === "number" && args.limit > 0 ? Math.min(args.limit, 30) : 10;
    const params = new URLSearchParams({ q: String(args.query), per_page: String(limit) });
    const res = await fetch(`https://api.github.com/search/code?${params}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github.text-match+json",
      },
    });
    const data = (await res.json()) as { items?: CodeSearchItem[]; message?: string };
    if (!res.ok) throw new Error(`GitHub REST API error (${res.status}): ${data.message ?? JSON.stringify(data)}`);
    const items = data.items ?? [];
    if (!items.length) return "(no results)";
    return items
      .map((item) => {
        const snippet = item.text_matches?.[0]?.fragment?.replace(/\s+/g, " ").trim().slice(0, 200);
        return `${item.repository?.full_name ?? "?"} — ${item.path}${snippet ? `\n  ${snippet}` : ""}`;
      })
      .join("\n\n");
  },
};

export const githubExtraTools: ToolDefinition[] = [
  listIssuesTool,
  createIssueTool,
  commentOnIssueTool,
  listReviewCommentsTool,
  postReviewCommentTool,
  searchCodeTool,
];
