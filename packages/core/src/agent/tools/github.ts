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
