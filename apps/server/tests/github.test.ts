import { describe, it, expect, vi, afterEach } from "vitest";
import { listRepos } from "../src/github.js";

function jsonResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    statusText: ok ? "OK" : "Error",
    json: async () => body,
  } as Response;
}

function repo(fullName: string) {
  return {
    full_name: fullName,
    clone_url: `https://github.com/${fullName}.git`,
    default_branch: "main",
    private: false,
    updated_at: "2026-01-01T00:00:00Z",
  };
}

describe("listRepos", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("maps GitHub's repo shape to a simplified summary", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse([repo("owner/one"), repo("owner/two")]))
    );

    const repos = await listRepos("tok");
    expect(repos).toEqual([
      { fullName: "owner/one", cloneUrl: "https://github.com/owner/one.git", defaultBranch: "main", private: false, updatedAt: "2026-01-01T00:00:00Z" },
      { fullName: "owner/two", cloneUrl: "https://github.com/owner/two.git", defaultBranch: "main", private: false, updatedAt: "2026-01-01T00:00:00Z" },
    ]);
  });

  it("stops paginating once a page comes back under 100 results", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([repo("owner/one")]));
    vi.stubGlobal("fetch", fetchMock);

    await listRepos("tok");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("paginates while pages come back full, up to the page cap", async () => {
    const fullPage = Array.from({ length: 100 }, (_, i) => repo(`owner/repo${i}`));
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(fullPage));
    vi.stubGlobal("fetch", fetchMock);

    const repos = await listRepos("tok");
    expect(fetchMock).toHaveBeenCalledTimes(3); // MAX_PAGES
    expect(repos).toHaveLength(300);
  });

  it("throws a clear error when GitHub returns a non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ message: "Bad credentials" }, false, 401)));

    await expect(listRepos("bad-token")).rejects.toThrow(/Bad credentials/);
  });
});
