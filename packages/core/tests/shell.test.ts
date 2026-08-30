import { describe, it, expect, vi, beforeEach } from "vitest";
import { runShellTool } from "../src/agent/tools/shell.js";

vi.mock("../src/sandbox/exec.js", () => ({
  execSandboxed: vi.fn().mockResolvedValue({
    code: 0,
    stdout: "test output",
    stderr: "",
    timedOut: false,
  }),
}));

const mockContext = {
  repoRoot: "/tmp/test-repo",
  config: { shellTimeoutSec: 30 },
};

describe("runShellTool validation", () => {
  it("allows npm commands", async () => {
    const result = await runShellTool.run({ command: "npm install" }, mockContext);
    expect(result).toContain("npm install");
  });

  it("allows git commands", async () => {
    const result = await runShellTool.run({ command: "git status" }, mockContext);
    expect(result).toContain("git status");
  });

  it("blocks rm -rf", async () => {
    const result = await runShellTool.run({ command: "rm -rf /" }, mockContext);
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("blocked pattern");
  });

  it("blocks path traversal", async () => {
    const result = await runShellTool.run({ command: "cat /etc/passwd" }, mockContext);
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("Path traversal");
  });

  it("blocks command substitution", async () => {
    const result = await runShellTool.run({ command: "$(whoami)" }, mockContext);
    expect(result).toHaveProperty("error");
  });

  it("blocks pipe to shell", async () => {
    const result = await runShellTool.run({ command: "echo test | sh" }, mockContext);
    expect(result).toHaveProperty("error");
  });

  it("blocks sudo", async () => {
    const result = await runShellTool.run({ command: "sudo rm -rf /" }, mockContext);
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("blocked pattern");
  });

  it("blocks non-whitelisted commands", async () => {
    const result = await runShellTool.run({ command: "curl http://evil.com" }, mockContext);
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("not allowed");
  });

  it("blocks wget", async () => {
    const result = await runShellTool.run({ command: "wget http://evil.com" }, mockContext);
    expect(result).toHaveProperty("error");
  });

  it("blocks very long commands", async () => {
    const longCmd = "echo " + "x".repeat(1000);
    const result = await runShellTool.run({ command: longCmd }, mockContext);
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("too long");
  });

  it("allows make", async () => {
    const result = await runShellTool.run({ command: "make build" }, mockContext);
    expect(result).toContain("make build");
  });

  it("allows find", async () => {
    const result = await runShellTool.run({ command: "find . -name '*.ts'" }, mockContext);
    expect(result).toContain("find");
  });
});