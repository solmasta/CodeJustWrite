import { describe, it, expect, beforeEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { execSandboxed } from "../src/sandbox/exec.js";
import {
  gitStatusTool,
  gitDiffTool,
  gitCommitTool,
  gitCreateBranchTool,
  gitFetchTool,
  gitCheckoutTool,
  gitMergeTool,
  gitMergeAbortTool,
} from "../src/agent/tools/git.js";
import { makeCtx, tempDir } from "./testUtils.js";

async function run(cwd: string, cmd: string): Promise<void> {
  const result = await execSandboxed(cmd, { cwd, timeoutSec: 10 });
  if (result.code !== 0) throw new Error(`${cmd} failed: ${result.stderr || result.stdout}`);
}

async function initRepo(): Promise<string> {
  const dir = tempDir("cjw-git-");
  await execSandboxed("git init -q -b main", { cwd: dir, timeoutSec: 10 });
  await execSandboxed('git config user.email "test@example.com"', { cwd: dir, timeoutSec: 10 });
  await execSandboxed('git config user.name "Test"', { cwd: dir, timeoutSec: 10 });
  await fs.writeFile(path.join(dir, "README.md"), "hello\n");
  await execSandboxed("git add -A && git commit -q -m init", { cwd: dir, timeoutSec: 10 });
  return dir;
}

/**
 * Builds a "remote" repo with a second branch, then single-branch shallow
 * clones it the same way apps/server/src/session.ts clones a session's
 * working repo — so tests exercise the exact scenario where only one
 * branch is present locally and every other branch must be fetched.
 */
async function initSingleBranchClone(): Promise<string> {
  const remote = await initRepo();
  await run(remote, "git checkout -b feature -q");
  await fs.writeFile(path.join(remote, "feature.txt"), "from feature\n");
  await run(remote, "git add -A && git commit -q -m feature-commit");
  await run(remote, "git checkout main -q");

  const clone = tempDir("cjw-git-clone-");
  await run(path.dirname(clone), `git clone -q --depth 50 --branch main "${remote}" "${clone}"`);
  return clone;
}

/**
 * Builds a shallow clone where main and feature share a real common ancestor, but neither
 * branch's shallow-fetched history reaches it — reproducing the false "refusing to merge
 * unrelated histories" a real shallow session clone hit against an actual old PicPocket branch.
 */
async function initUnrelatedHistoryClone(): Promise<string> {
  const remote = await initRepo(); // C0
  await fs.writeFile(path.join(remote, "main-only.txt"), "main change\n");
  await run(remote, "git add -A && git commit -q -m main-commit"); // C1, child of C0

  await run(remote, "git checkout -b feature HEAD~1 -q"); // branch off C0
  await fs.writeFile(path.join(remote, "feature.txt"), "from feature\n");
  await run(remote, "git add -A && git commit -q -m feature-commit"); // C2, sibling of C1
  await run(remote, "git checkout main -q");

  const clone = tempDir("cjw-git-shallow-");
  // git silently ignores --depth for a plain filesystem path ("--depth is ignored in local
  // clones"), so a file:// URL is required to actually get shallow-clone behavior here.
  await run(path.dirname(clone), `git clone -q --depth 1 --branch main "file://${remote}" "${clone}"`);
  // A subsequent fetch on an already-shallow repo still respects the original depth unless told
  // otherwise, so this brings in only feature's tip — no shared history with main's tip either.
  await run(clone, "git fetch -q origin feature:refs/remotes/origin/feature");
  return clone;
}

describe("git tools", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await initRepo();
  });

  it("git_status reports a clean tree after init", async () => {
    const ctx = makeCtx(repo);
    const status = await gitStatusTool.run({}, ctx);
    expect(status).toContain("main");
  });

  it("git_diff and git_commit reflect a new change", async () => {
    const ctx = makeCtx(repo);
    await fs.writeFile(path.join(repo, "README.md"), "hello world\n");

    const diff = await gitDiffTool.run({}, ctx);
    expect(diff).toContain("-hello");
    expect(diff).toContain("+hello world");

    const commitOutput = await gitCommitTool.run({ message: "update readme" }, ctx);
    expect(commitOutput).toContain("update readme");

    const cleanDiff = await gitDiffTool.run({}, ctx);
    expect(cleanDiff).toBe("(no changes)");
  });

  it("git_create_branch switches to a new branch", async () => {
    const ctx = makeCtx(repo);
    await gitCreateBranchTool.run({ branch: "feature/x" }, ctx);
    const branch = await execSandboxed("git rev-parse --abbrev-ref HEAD", { cwd: repo, timeoutSec: 10 });
    expect(branch.stdout.trim()).toBe("feature/x");
  });

  it("git_create_branch rejects a branch name with disallowed characters instead of mangling it", async () => {
    const ctx = makeCtx(repo);
    await expect(gitCreateBranchTool.run({ branch: "feature x" }, ctx)).rejects.toThrow("Invalid branch name");
    const branch = await execSandboxed("git rev-parse --abbrev-ref HEAD", { cwd: repo, timeoutSec: 10 });
    // Must still be on main: no branch called "featurex" should have been created.
    expect(branch.stdout.trim()).toBe("main");
  });

  it("git_merge fails on a branch a single-branch session clone never fetched", async () => {
    const clone = await initSingleBranchClone();
    const ctx = makeCtx(clone);
    await expect(gitMergeTool.run({ branch: "feature" }, ctx)).rejects.toThrow();
  });

  it(
    "git_merge recovers from a shallow clone's false 'unrelated histories' by unshallowing and retrying",
    async () => {
      const clone = await initUnrelatedHistoryClone();
      const ctx = makeCtx(clone);

      const isShallow = await execSandboxed("git rev-parse --is-shallow-repository", { cwd: clone, timeoutSec: 10 });
      expect(isShallow.stdout.trim()).toBe("true");

      // A plain merge attempt would throw "refusing to merge unrelated histories" here — the
      // tool should recover from that on its own rather than surface it as a merge failure.
      await gitMergeTool.run({ branch: "origin/feature" }, ctx);

      const files = await fs.readdir(clone);
      expect(files).toContain("main-only.txt");
      expect(files).toContain("feature.txt");
    },
    20000
  );

  it("git_fetch then git_checkout then git_merge brings in a branch not present in a single-branch clone", async () => {
    const clone = await initSingleBranchClone();
    const ctx = makeCtx(clone);

    await gitFetchTool.run({ branch: "feature" }, ctx);
    await gitCheckoutTool.run({ branch: "feature" }, ctx);
    let branch = await execSandboxed("git rev-parse --abbrev-ref HEAD", { cwd: clone, timeoutSec: 10 });
    expect(branch.stdout.trim()).toBe("feature");

    await gitCheckoutTool.run({ branch: "main" }, ctx);
    branch = await execSandboxed("git rev-parse --abbrev-ref HEAD", { cwd: clone, timeoutSec: 10 });
    expect(branch.stdout.trim()).toBe("main");

    const mergeOutput = await gitMergeTool.run({ branch: "feature" }, ctx);
    expect(mergeOutput).toBeDefined();
    const files = await fs.readdir(clone);
    expect(files).toContain("feature.txt");
  });

  it("git_checkout reports a clear error for a branch that hasn't been fetched", async () => {
    const clone = await initSingleBranchClone();
    const ctx = makeCtx(clone);
    await expect(gitCheckoutTool.run({ branch: "feature" }, ctx)).rejects.toThrow("git_fetch");
  });

  it("git_merge conflict leaves the working tree mid-merge, and git_merge_abort restores it", async () => {
    const ctx = makeCtx(repo);
    await gitCreateBranchTool.run({ branch: "branch-a" }, ctx);
    await fs.writeFile(path.join(repo, "README.md"), "from branch-a\n");
    await gitCommitTool.run({ message: "branch-a edit" }, ctx);

    await run(repo, "git checkout main -q");
    await gitCreateBranchTool.run({ branch: "branch-b" }, ctx);
    await fs.writeFile(path.join(repo, "README.md"), "from branch-b\n");
    await gitCommitTool.run({ message: "branch-b edit" }, ctx);

    await run(repo, "git checkout main -q");
    await gitMergeTool.run({ branch: "branch-a" }, ctx);

    await expect(gitMergeTool.run({ branch: "branch-b" }, ctx)).rejects.toThrow("Merge conflict");

    const mergeHead = await execSandboxed("git rev-parse -q --verify MERGE_HEAD", { cwd: repo, timeoutSec: 10 });
    expect(mergeHead.code).toBe(0);

    const abortOutput = await gitMergeAbortTool.run({}, ctx);
    expect(abortOutput).toContain("aborted");

    const mergeHeadAfter = await execSandboxed("git rev-parse -q --verify MERGE_HEAD", {
      cwd: repo,
      timeoutSec: 10,
    });
    expect(mergeHeadAfter.code).not.toBe(0);

    const content = await fs.readFile(path.join(repo, "README.md"), "utf8");
    expect(content).toBe("from branch-a\n");
  });
});
