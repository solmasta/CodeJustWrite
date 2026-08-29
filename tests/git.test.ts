import { describe, it, expect, beforeEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { execSandboxed } from "../src/sandbox/exec.js";
import { gitStatusTool, gitDiffTool, gitCommitTool, gitCreateBranchTool } from "../src/agent/tools/git.js";
import { makeCtx, tempDir } from "./testUtils.js";

async function initRepo(): Promise<string> {
  const dir = tempDir("cjw-git-");
  await execSandboxed("git init -q -b main", { cwd: dir, timeoutSec: 10 });
  await execSandboxed('git config user.email "test@example.com"', { cwd: dir, timeoutSec: 10 });
  await execSandboxed('git config user.name "Test"', { cwd: dir, timeoutSec: 10 });
  await fs.writeFile(path.join(dir, "README.md"), "hello\n");
  await execSandboxed("git add -A && git commit -q -m init", { cwd: dir, timeoutSec: 10 });
  return dir;
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
});
