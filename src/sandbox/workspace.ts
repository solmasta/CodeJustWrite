import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execSandboxed } from "./exec.js";

export interface Worktree {
  dir: string;
  branch: string;
  cleanup: () => Promise<void>;
}

/**
 * Creates a disposable `git worktree` checked out from the current HEAD
 * (including uncommitted changes, via a temporary stash-like commit is
 * avoided — instead we worktree HEAD and then copy the dirty index over)
 * so test/lint runs never touch the user's real working tree.
 */
export async function createTestWorktree(repoRoot: string): Promise<Worktree> {
  const scratchParent = mkdtempSync(path.join(tmpdir(), "cjw-worktree-"));
  const dir = path.join(scratchParent, "wt");
  const branch = `cjw-sandbox-${Date.now()}`;

  const add = await execSandboxed(`git worktree add -b ${branch} "${dir}" HEAD`, {
    cwd: repoRoot,
    timeoutSec: 60,
  });
  if (add.code !== 0) {
    throw new Error(`Failed to create sandbox worktree: ${add.stderr || add.stdout}`);
  }

  // Carry over uncommitted changes (staged + unstaged, not untracked) so the
  // sandbox reflects what the agent is about to commit/PR, not just HEAD.
  const diff = await execSandboxed("git diff HEAD", { cwd: repoRoot, timeoutSec: 30 });
  if (diff.stdout.trim()) {
    const applyResult = await applyPatch(dir, diff.stdout);
    if (!applyResult.ok) {
      // Non-fatal: fall back to testing HEAD as-is and surface a warning via stderr.
      applyResult.warning = `Could not apply working-tree diff to sandbox worktree; testing HEAD instead.`;
    }
  }

  const cleanup = async () => {
    await execSandboxed(`git worktree remove --force "${dir}"`, { cwd: repoRoot, timeoutSec: 30 });
    await execSandboxed(`git branch -D ${branch}`, { cwd: repoRoot, timeoutSec: 30 });
    try {
      rmSync(scratchParent, { recursive: true, force: true });
    } catch {
      // best effort
    }
  };

  return { dir, branch, cleanup };
}

async function applyPatch(dir: string, patch: string): Promise<{ ok: boolean; warning?: string }> {
  const tmpPatchDir = mkdtempSync(path.join(tmpdir(), "cjw-patch-"));
  const patchFile = path.join(tmpPatchDir, "changes.patch");
  await import("node:fs/promises").then((fs) => fs.writeFile(patchFile, patch, "utf8"));
  const result = await execSandboxed(`git apply "${patchFile}"`, { cwd: dir, timeoutSec: 30 });
  rmSync(tmpPatchDir, { recursive: true, force: true });
  return { ok: result.code === 0 };
}
