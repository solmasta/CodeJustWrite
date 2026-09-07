import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { runShellTool } from "../src/agent/tools/shell.js";
import { runTestsTool } from "../src/agent/tools/tests.js";
import { execSandboxed } from "../src/sandbox/exec.js";
import { makeCtx, tempDir } from "./testUtils.js";

async function initGitRepo(dir: string): Promise<void> {
  await execSandboxed("git init -q -b main", { cwd: dir, timeoutSec: 15 });
  await execSandboxed('git config user.email "test@example.com"', { cwd: dir, timeoutSec: 15 });
  await execSandboxed('git config user.name "Test"', { cwd: dir, timeoutSec: 15 });
  const entries = (await fs.readdir(dir)).filter((e) => e !== ".git");
  if (!entries.length) await fs.writeFile(path.join(dir, ".gitkeep"), "");
  await execSandboxed("git add -A && git commit -q -m init", { cwd: dir, timeoutSec: 15 });
}

// run_shell, run_tests, and browser_check each spawn their own memory-heavy child process (or, for
// browser_check, an out-of-process Chromium) — see heavyOpLock.ts. A container that only limits
// concurrency *within* one tool or one session can still let two different tools, or two different
// sessions, pile their heavy work up at the same moment; these tests prove the shared lock actually
// serializes across that boundary, not just within a single tool's own calls.
describe("heavyOperationLock", () => {
  it("serializes two overlapping run_shell calls, second waits for the first", async () => {
    const dir = tempDir("cjw-heavylock-shell-");
    const events: string[] = [];

    const first = runShellTool.run(
      { command: "node -e \"setTimeout(()=>{}, 150)\"" },
      makeCtx(dir)
    ).then(() => events.push("A end"));
    events.push("A start");

    // Give A's lock acquisition a tick before starting B, so this isn't just testing call order.
    await new Promise((r) => setTimeout(r, 10));
    const second = runShellTool.run({ command: "echo done" }, makeCtx(dir)).then(() => events.push("B end"));
    events.push("B start");

    await Promise.all([first, second]);

    // B's actual command only ever runs after A's finishes, even though B was queued while A was
    // still sleeping — proves B waited on the shared lock rather than running concurrently.
    expect(events.indexOf("A end")).toBeLessThan(events.indexOf("B end"));
  }, 10000);

  it("blocks a run_tests call behind an in-flight run_shell call on a different session", async () => {
    const shellDir = tempDir("cjw-heavylock-cross-shell-");
    const testsDir = tempDir("cjw-heavylock-cross-tests-");
    await initGitRepo(testsDir); // no manifest — run_tests resolves almost immediately once it gets the lock

    const order: string[] = [];

    const shellRun = runShellTool
      .run({ command: "node -e \"setTimeout(()=>{}, 150)\"" }, makeCtx(shellDir))
      .then(() => order.push("shell done"));

    await new Promise((r) => setTimeout(r, 10)); // let the shell call actually acquire the lock first

    const testsRun = runTestsTool.run({}, makeCtx(testsDir)).then((output) => {
      order.push("tests done");
      return output;
    });

    const output = await testsRun;
    await shellRun;

    expect(output).toContain("No recognized project manifest found");
    // If run_tests had its own independent lock (or none at all), it would finish first — it has
    // nothing to install or run. It only finishes second because it queued behind run_shell on the
    // one lock they now share.
    expect(order).toEqual(["shell done", "tests done"]);
  }, 10000);
});
