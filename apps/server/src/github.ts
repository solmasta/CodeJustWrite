export interface RepoSummary {
  fullName: string;
  cloneUrl: string;
  defaultBranch: string;
  private: boolean;
  updatedAt: string;
}

const MAX_PAGES = 3; // caps at 300 repos, plenty for a personal account

interface GitHubRepo {
  full_name: string;
  clone_url: string;
  default_branch: string;
  private: boolean;
  updated_at: string;
}

/** Lists repos reachable by the server's configured GITHUB_TOKEN, most recently updated first. */
export async function listRepos(token: string): Promise<RepoSummary[]> {
  const repos: RepoSummary[] = [];

  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await fetch(
      `https://api.github.com/user/repos?per_page=100&sort=updated&direction=desc&page=${page}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
        },
      }
    );

    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      throw new Error(`GitHub API error (${res.status}): ${body.message ?? res.statusText}`);
    }

    const data = (await res.json()) as GitHubRepo[];
    for (const r of data) {
      repos.push({
        fullName: r.full_name,
        cloneUrl: r.clone_url,
        defaultBranch: r.default_branch,
        private: r.private,
        updatedAt: r.updated_at,
      });
    }

    if (data.length < 100) break; // last page
  }

  return repos;
}
