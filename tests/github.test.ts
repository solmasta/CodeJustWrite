import { describe, it, expect } from "vitest";
import { execSandboxed } from "../src/sandbox/exec.js";
import { createPullRequestTool } from "../src/agent/tools/github.js";
import { makeCtx, tempDir } from "./testUtils.js";

describe("create_pull_request tool", () => {
  it("fails clearly when neither gh CLI nor GITHUB_TOKEN is available", async () => {
    const dir = tempDir("cjw-gh-");
    await execSandboxed("git init -q -b main", { cwd: dir, timeoutSec: 10 });
    await execSandboxed("git remote add origin https://github.com/example/repo.git", {
      cwd: dir,
      timeoutSec: 10,
    });

    const ctx = makeCtx(dir);
    await expect(createPullRequestTool.run({ title: "t", body: "b" }, ctx)).rejects.toThrow(
      /gh.*CLI.*isn't installed|GITHUB_TOKEN/i
    );
  });
});
