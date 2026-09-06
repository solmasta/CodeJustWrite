import { describe, it, expect } from "vitest";
import { execSandboxed } from "../src/sandbox/exec.js";

describe("execSandboxed", () => {
  it("captures stdout and a zero exit code", async () => {
    const result = await execSandboxed("echo hello", { cwd: process.cwd(), timeoutSec: 5 });
    expect(result.stdout.trim()).toBe("hello");
    expect(result.code).toBe(0);
    expect(result.timedOut).toBe(false);
  });

  it("captures a non-zero exit code and stderr", async () => {
    const result = await execSandboxed("echo oops 1>&2; exit 3", { cwd: process.cwd(), timeoutSec: 5 });
    expect(result.code).toBe(3);
    expect(result.stderr.trim()).toBe("oops");
  });

  it("kills commands that exceed the timeout", async () => {
    const result = await execSandboxed("sleep 5", { cwd: process.cwd(), timeoutSec: 1 });
    expect(result.timedOut).toBe(true);
  }, 10_000);

  it("truncates output past maxOutputBytes, marking how much was omitted", async () => {
    const result = await execSandboxed("yes x | head -c 1000000", {
      cwd: process.cwd(),
      timeoutSec: 5,
      maxOutputBytes: 100,
    });
    expect(result.stdout).toContain("bytes omitted");
    expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThan(1_000_000);
  });

  it("keeps the tail, not just the head, when truncating — the useful part of most tool output", async () => {
    // A command whose meaningful content (a distinctive final line, like a test runner's summary)
    // is at the END of a large output — the exact shape head-only truncation used to lose.
    const result = await execSandboxed("yes x | head -c 5000; echo; echo DISTINCTIVE_TAIL_MARKER", {
      cwd: process.cwd(),
      timeoutSec: 5,
      maxOutputBytes: 100,
    });
    expect(result.stdout).toContain("DISTINCTIVE_TAIL_MARKER");
  });

  it("caps a spawned Node process's own heap by default, so it can't OOM the whole container unchecked", async () => {
    const result = await execSandboxed("echo $NODE_OPTIONS", { cwd: process.cwd(), timeoutSec: 5 });
    expect(result.stdout.trim()).toBe("--max-old-space-size=300");
  });

  it("doesn't override a caller-provided NODE_OPTIONS", async () => {
    const result = await execSandboxed("echo $NODE_OPTIONS", {
      cwd: process.cwd(),
      timeoutSec: 5,
      env: { NODE_OPTIONS: "--stack-size=2000" },
    });
    expect(result.stdout.trim()).toBe("--stack-size=2000");
  });
});
