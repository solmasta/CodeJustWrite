import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { execSandboxed } from "../src/sandbox/exec.js";
import { runTestsTool } from "../src/agent/tools/tests.js";
import { makeCtx, tempDir } from "./testUtils.js";

async function run(cwd: string, cmd: string): Promise<void> {
  const result = await execSandboxed(cmd, { cwd, timeoutSec: 15 });
  if (result.code !== 0) throw new Error(`${cmd} failed: ${result.stderr || result.stdout}`);
}

async function initGitRepo(dir: string): Promise<void> {
  await run(dir, "git init -q -b main");
  await run(dir, 'git config user.email "test@example.com"');
  await run(dir, 'git config user.name "Test"');
  // createTestWorktree requires HEAD to exist, so make sure there's at least one commit even
  // when the caller hasn't written any files of its own yet (readdir here always sees at least
  // ".git" itself, right after git init).
  const entries = (await fs.readdir(dir)).filter((e) => e !== ".git");
  if (!entries.length) await fs.writeFile(path.join(dir, ".gitkeep"), "");
  await run(dir, "git add -A && git commit -q -m init");
}

describe("run_tests", () => {
  it("reports no package.json rather than failing when there's nothing to run", async () => {
    const dir = tempDir("cjw-tests-empty-");
    await initGitRepo(dir);
    const output = await runTestsTool.run({}, makeCtx(dir));
    expect(output).toContain("No package.json found");
  });

  it(
    // Reproduces the PicPocket layout: a root package.json whose "test" script is just
    // `cd frontend && npm test`, with frontend's own dependencies never installed by a naive
    // "npm install at root only" tool — the delegated command then fails looking like a real
    // test failure ("jest: not found") when the actual test suite is perfectly runnable.
    "installs a delegate subdirectory's own dependencies when the script cd's into it",
    async () => {
      const dir = tempDir("cjw-tests-delegate-");
      await fs.mkdir(path.join(dir, "sub"));
      await fs.writeFile(
        path.join(dir, "package.json"),
        JSON.stringify({ name: "root", version: "1.0.0", scripts: { test: "cd sub && npm test" } })
      );
      await fs.writeFile(
        path.join(dir, "sub", "package.json"),
        JSON.stringify({ name: "sub", version: "1.0.0", scripts: { test: "node -e \"console.log('sub ran')\"" } })
      );
      await initGitRepo(dir);

      const output = await runTestsTool.run({}, makeCtx(dir));
      expect(output).toContain("installed sub deps");
      expect(output).toContain("sub ran");
      expect(output).toContain("exit code 0");
    },
    30000
  );

  it(
    // ERESOLVE peer-dependency conflicts are extremely common in real repos (older
    // React/CRA-style apps especially), and a plain "npm install" hard-fails on them even
    // though --legacy-peer-deps resolves the exact same tree just fine. A fake `npm` on PATH
    // makes this deterministic and offline instead of depending on a real conflicting package.
    "retries npm install with --legacy-peer-deps when the primary install hits ERESOLVE",
    async () => {
      const dir = tempDir("cjw-tests-eresolve-");
      await fs.writeFile(
        path.join(dir, "package.json"),
        JSON.stringify({ name: "root", version: "1.0.0", scripts: { test: "true" } })
      );
      await initGitRepo(dir);

      const shimDir = tempDir("cjw-fake-npm-");
      const shimPath = path.join(shimDir, "npm");
      await fs.writeFile(
        shimPath,
        [
          "#!/usr/bin/env node",
          "const [, , sub, ...rest] = process.argv;",
          "if (sub === 'install') {",
          "  if (rest.includes('--legacy-peer-deps')) { console.log('shim: legacy-peer-deps install ok'); process.exit(0); }",
          "  console.error('npm error ERESOLVE could not resolve dependency tree'); process.exit(1);",
          "}",
          "if (sub === 'run') { console.log('shim: ran ' + rest[0]); process.exit(0); }",
          "process.exit(0);",
          "",
        ].join("\n")
      );
      await fs.chmod(shimPath, 0o755);

      const originalPath = process.env.PATH;
      process.env.PATH = `${shimDir}${path.delimiter}${originalPath}`;
      try {
        const output = await runTestsTool.run({}, makeCtx(dir));
        // A successful install's own stdout isn't surfaced (only a failure's is) — but the shim
        // always fails a plain "npm install" and only ever succeeds with --legacy-peer-deps, so
        // reaching (and passing) the run step at all is only possible via that retry path.
        expect(output).not.toContain("Dependency install failed");
        expect(output).toContain("shim: ran test");
        expect(output).toContain("exit code 0");
      } finally {
        process.env.PATH = originalPath;
      }
    },
    30000
  );
});
