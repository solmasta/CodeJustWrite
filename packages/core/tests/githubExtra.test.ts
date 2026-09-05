import { describe, it, expect, vi, afterEach } from "vitest";
import { execSandboxed } from "../src/sandbox/exec.js";
import {
  listIssuesTool,
  createIssueTool,
  commentOnIssueTool,
  listReviewCommentsTool,
  postReviewCommentTool,
  searchCodeTool,
} from "../src/agent/tools/github.js";
import { makeCtx, tempDir } from "./testUtils.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

async function repoWithOrigin(): Promise<string> {
  const dir = tempDir("cjw-gh-extra-");
  await execSandboxed("git init -q -b main", { cwd: dir, timeoutSec: 10 });
  await execSandboxed("git remote add origin https://github.com/example/repo.git", { cwd: dir, timeoutSec: 10 });
  return dir;
}

function ctxWithToken(dir: string) {
  return makeCtx(dir, { config: { ...makeCtx(dir).config, githubToken: "ghp_test" } });
}

describe("GitHub extra tools — missing configuration", () => {
  it("fails clearly when GITHUB_TOKEN isn't configured", async () => {
    const dir = await repoWithOrigin();
    await expect(listIssuesTool.run({}, makeCtx(dir))).rejects.toThrow(/GITHUB_TOKEN/);
  });
});

describe("github_list_issues", () => {
  it("filters out pull requests and formats labels", async () => {
    const dir = await repoWithOrigin();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse([
          { number: 1, title: "Real issue", state: "open", labels: [{ name: "bug" }] },
          { number: 2, title: "A PR", state: "open", pull_request: {} },
        ])
      )
    );

    const result = await listIssuesTool.run({}, ctxWithToken(dir));

    expect(result).toContain("#1 [open] Real issue (bug)");
    expect(result).not.toContain("#2");
  });

  it("reports an empty result clearly", async () => {
    const dir = await repoWithOrigin();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([])));
    const result = await listIssuesTool.run({}, ctxWithToken(dir));
    expect(result).toMatch(/no issues/i);
  });

  it("uses explicit owner/repo over the origin remote when given", async () => {
    const dir = await repoWithOrigin();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([]));
    vi.stubGlobal("fetch", fetchMock);

    await listIssuesTool.run({ owner: "other", repo: "thing" }, ctxWithToken(dir));

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/repos/other/thing/issues"),
      expect.anything()
    );
  });
});

describe("github_create_issue and github_comment_on_issue", () => {
  it("requires confirmation and posts title/body/labels", async () => {
    const dir = await repoWithOrigin();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ number: 5, html_url: "https://x/5" }));
    vi.stubGlobal("fetch", fetchMock);

    expect(createIssueTool.requiresConfirmation).toBe(true);
    const result = await createIssueTool.run({ title: "t", body: "b", labels: "a, b" }, ctxWithToken(dir));

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.github.com/repos/example/repo/issues");
    expect(JSON.parse(String(init.body))).toEqual({ title: "t", body: "b", labels: ["a", "b"] });
    expect(result).toContain("#5");
  });

  it("posts a comment to the issue-comments endpoint (works for PRs too)", async () => {
    const dir = await repoWithOrigin();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ html_url: "https://x/comment" }));
    vi.stubGlobal("fetch", fetchMock);

    expect(commentOnIssueTool.requiresConfirmation).toBe(true);
    await commentOnIssueTool.run({ issueNumber: 7, body: "hi" }, ctxWithToken(dir));

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.github.com/repos/example/repo/issues/7/comments");
    expect(JSON.parse(String(init.body))).toEqual({ body: "hi" });
  });
});

describe("review comments", () => {
  it("lists inline review comments", async () => {
    const dir = await repoWithOrigin();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse([{ path: "src/a.ts", line: 12, body: "fix this", user: { login: "alice" } }])
      )
    );

    expect(listReviewCommentsTool.readOnly).toBe(true);
    const result = await listReviewCommentsTool.run({ pullNumber: 3 }, ctxWithToken(dir));
    expect(result).toBe("src/a.ts:12 — alice: fix this");
  });

  it("posts a review comment using the PR's head sha", async () => {
    const dir = await repoWithOrigin();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ head: { sha: "abc123" } }))
      .mockResolvedValueOnce(jsonResponse({ html_url: "https://x/rc" }));
    vi.stubGlobal("fetch", fetchMock);

    expect(postReviewCommentTool.requiresConfirmation).toBe(true);
    await postReviewCommentTool.run({ pullNumber: 3, path: "src/a.ts", line: 12, body: "fix this" }, ctxWithToken(dir));

    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe("https://api.github.com/repos/example/repo/pulls/3/comments");
    expect(JSON.parse(String(init.body))).toEqual({
      body: "fix this",
      commit_id: "abc123",
      path: "src/a.ts",
      line: 12,
      side: "RIGHT",
    });
  });

  it("fails clearly if the PR's head sha can't be resolved", async () => {
    const dir = await repoWithOrigin();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({})));
    await expect(
      postReviewCommentTool.run({ pullNumber: 3, path: "src/a.ts", line: 12, body: "x" }, ctxWithToken(dir))
    ).rejects.toThrow(/head commit/);
  });
});

describe("github_search_code", () => {
  it("formats results with repo, path, and a trimmed snippet", async () => {
    const dir = await repoWithOrigin();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          items: [
            {
              path: "src/foo.ts",
              repository: { full_name: "octocat/hello" },
              text_matches: [{ fragment: "  function   foo() {}  \n" }],
            },
          ],
        })
      )
    );

    const result = await searchCodeTool.run({ query: "foo" }, ctxWithToken(dir));
    expect(result).toContain("octocat/hello — src/foo.ts");
    expect(result).toContain("function foo() {}");
  });

  it("reports no results clearly", async () => {
    const dir = await repoWithOrigin();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ items: [] })));
    const result = await searchCodeTool.run({ query: "nothing" }, ctxWithToken(dir));
    expect(result).toMatch(/no results/i);
  });
});
