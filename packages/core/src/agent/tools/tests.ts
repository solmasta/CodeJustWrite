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

function installCommandFor(pkgManager: "npm" | "yarn" | "pnpm"): string {
  return pkgManager === "pnpm" ? "pnpm install" : pkgManager === "yarn" ? "yarn install" : "npm install";
}

interface InstallResult {
  ok: boolean;
  output: string;
}

/**
 * Installs dependencies in `dir`, retrying npm installs that fail on a peer-dependency conflict
 * with `--legacy-peer-deps`. ERESOLVE failures are extremely common in real repos (older
 * React/CRA-style apps especially have peer ranges stricter than what actually works), and
 * relaxing peer-dep strictness — unlike --force — doesn't change which versions get resolved,
 * only whether npm hard-fails over a peer mismatch.
 */
async function installDeps(dir: string, pkgManager: "npm" | "yarn" | "pnpm"): Promise<InstallResult> {
  const primary = await execSandboxed(installCommandFor(pkgManager), { cwd: dir, timeoutSec: 300 });
  if (primary.code === 0) return { ok: true, output: primary.stdout };

  const output = primary.stderr || primary.stdout;
  if (pkgManager === "npm" && /ERESOLVE/.test(output)) {
    const retry = await execSandboxed("npm install --legacy-peer-deps", { cwd: dir, timeoutSec: 300 });
    if (retry.code === 0) return { ok: true, output: retry.stdout };
    return { ok: false, output: retry.stderr || retry.stdout };
  }
  return { ok: false, output };
}

async function hasPackageJson(dir: string): Promise<boolean> {
  return fs
    .access(path.join(dir, "package.json"))
    .then(() => true)
    .catch(() => false);
}

/**
 * Many repos aren't a formal npm/yarn/pnpm workspace but still delegate a root script into a
 * subdirectory with its own package.json (e.g. "test": "cd frontend && npm test") — root's own
 * `install` never touches that subdirectory's dependencies, so the delegated command fails with
 * a misleading "command not found" that looks like a real test failure. Detect a leading `cd
 * <dir> &&` in the script's own command text (no shell execution involved) and, if that directory
 * has its own package.json, install its dependencies too before running anything.
 */
async function findDelegateDir(repoRoot: string, scriptCommand: string): Promise<string | null> {
  const match = scriptCommand.match(/^cd\s+(\S+)\s*&&/);
  if (!match) return null;
  const dir = path.resolve(repoRoot, match[1]);
  if (!dir.startsWith(path.resolve(repoRoot) + path.sep)) return null; // stay inside the repo
  return (await hasPackageJson(dir)) ? dir : null;
}

export const runTestsTool: ToolDefinition = {
  spec: {
    name: "run_tests",
    description:
      "Run the project's test suite (and optionally lint) inside an isolated git worktree carrying the current uncommitted changes, so the real working tree is never touched. Auto-detects npm/yarn/pnpm, installs a subdirectory's own dependencies when the script delegates into one (e.g. \"cd frontend && npm test\"), and retries an npm install with --legacy-peer-deps on a peer-dependency conflict.",
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
      if (!(await hasPackageJson(wt.dir))) {
        return "No package.json found — nothing to run. Provide explicit shell commands via run_shell instead.";
      }

      const pkgManager = await detectPackageManager(wt.dir);
      const install = await installDeps(wt.dir, pkgManager);
      if (!install.ok) {
        return `Dependency install failed in sandbox:\n${install.output}`;
      }

      const pkgJson = JSON.parse(await fs.readFile(path.join(wt.dir, "package.json"), "utf8")) as {
        scripts?: Record<string, string>;
      };
      const scriptCommand = pkgJson.scripts?.[script];
      const delegateDir = scriptCommand ? await findDelegateDir(wt.dir, scriptCommand) : null;
      let delegateNote = "";
      if (delegateDir) {
        const delegatePkgManager = await detectPackageManager(delegateDir);
        const delegateInstall = await installDeps(delegateDir, delegatePkgManager);
        if (!delegateInstall.ok) {
          return `Dependency install failed in sandbox (${path.relative(wt.dir, delegateDir)}):\n${delegateInstall.output}`;
        }
        delegateNote = `, installed ${path.relative(wt.dir, delegateDir)} deps via ${delegatePkgManager}`;
      }

      const runCmd = pkgManager === "npm" ? `npm run ${script}` : `${pkgManager} ${script}`;
      const result = await execSandboxed(runCmd, { cwd: wt.dir, timeoutSec: 600 });
      const status = result.timedOut ? "TIMED OUT" : `exit code ${result.code}`;
      return [
        `Ran '${script}' via ${pkgManager} in sandbox worktree${delegateNote} (${status})`,
        result.stdout,
        result.stderr,
      ].join("\n");
    } finally {
      await wt.cleanup();
    }
  },
};
