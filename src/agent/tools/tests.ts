import { promises as fs } from "node:fs";
import path from "node:path";
import { execSandboxed } from "../../sandbox/exec.js";
import { createTestWorktree } from "../../sandbox/workspace.js";
import type { ToolDefinition } from "./types.js";

async function detectPackageManager(dir: string): Promise<"npm" | "yarn" | "pnpm"> {
  if (
    await fs
      .access(path.join(dir, "pnpm-lock.yaml"))
      .then(() => true)
      .catch(() => false)
  )
    return "pnpm";
  if (
    await fs
      .access(path.join(dir, "yarn.lock"))
      .then(() => true)
      .catch(() => false)
  )
    return "yarn";
  return "npm";
}

export const runTestsTool: ToolDefinition = {
  spec: {
    name: "run_tests",
    description:
      "Run the project's test suite (and optionally lint) inside an isolated git worktree carrying the current uncommitted changes, so the real working tree is never touched. Auto-detects npm/yarn/pnpm.",
    parameters: {
      type: "object",
      properties: {
        script: {
          type: "string",
          description: "npm script to run, e.g. 'test' or 'lint'. Defaults to 'test'.",
        },
      },
    },
  },
  requiresConfirmation: false,
  async run(args, ctx) {
    const script = args.script ? String(args.script) : "test";
    const wt = await createTestWorktree(ctx.repoRoot);
    try {
      const pkgJsonExists = await fs
        .access(path.join(wt.dir, "package.json"))
        .then(() => true)
        .catch(() => false);
      if (!pkgJsonExists) {
        return "No package.json found — nothing to run. Provide explicit shell commands via run_shell instead.";
      }

      const pkgManager = await detectPackageManager(wt.dir);
      const installCmd =
        pkgManager === "pnpm" ? "pnpm install" : pkgManager === "yarn" ? "yarn install" : "npm install";
      const install = await execSandboxed(installCmd, { cwd: wt.dir, timeoutSec: 300 });
      if (install.code !== 0) {
        return `Dependency install failed in sandbox:\n${install.stderr || install.stdout}`;
      }

      const runCmd = pkgManager === "npm" ? `npm run ${script}` : `${pkgManager} ${script}`;
      const result = await execSandboxed(runCmd, { cwd: wt.dir, timeoutSec: 600 });
      const status = result.timedOut ? "TIMED OUT" : `exit code ${result.code}`;
      return [`Ran '${script}' via ${pkgManager} in sandbox worktree (${status})`, result.stdout, result.stderr].join(
        "\n"
      );
    } finally {
      await wt.cleanup();
    }
  },
};
