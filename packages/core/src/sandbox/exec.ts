import { spawn } from "node:child_process";

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
}

export interface ExecOptions {
  cwd: string;
  timeoutSec: number;
  env?: NodeJS.ProcessEnv;
  maxOutputBytes?: number;
}

// Halved from a prior 200_000 now that truncation keeps head+tail instead of head-only (see
// truncate() below) — a smaller cap is safe because what's kept is far more information-dense,
// and it means less of every large run_shell/run_tests output gets resent as tokens on every
// subsequent turn of the conversation.
const DEFAULT_MAX_OUTPUT_BYTES = 100_000;

/**
 * Runs a command as a constrained subprocess: bounded wall-clock timeout,
 * truncated output, and optional env overrides. Uses spawn with array args
 * to avoid shell interpretation when possible.
 */
export function execSandboxed(
  command: string,
  args: string[] | undefined,
  options: ExecOptions
): Promise<ExecResult>;
export function execSandboxed(
  command: string,
  options: ExecOptions
): Promise<ExecResult>;
export function execSandboxed(
  command: string,
  argsOrOptions: string[] | ExecOptions | undefined,
  maybeOptions?: ExecOptions
): Promise<ExecResult> {
  let args: string[] | undefined;
  let options: ExecOptions;
  
  if (Array.isArray(argsOrOptions)) {
    args = argsOrOptions;
    options = maybeOptions!;
  } else {
    args = undefined;
    options = argsOrOptions!;
  }

  const { cwd, timeoutSec, env, maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES } = options;
  const timeoutMs = timeoutSec * 1000;

  return new Promise((resolve) => {
    const child = args 
      ? spawn(command, args, { cwd, env: { ...process.env, ...env } })
      : spawn(command, { cwd, shell: true, env: { ...process.env, ...env } });

    let stdout = "";
    let stderr = "";
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGTERM");
      // Force kill after grace period
      setTimeout(() => child.kill("SIGKILL"), 5000);
    }, timeoutMs);

    function truncate(str: string): string {
      const buf = Buffer.from(str, "utf8");
      if (buf.byteLength <= maxOutputBytes) return str;
      // Keep a small head (what ran, early setup output) and most of the tail — a command's
      // actually useful content (test summaries, "N failed", the final error) is almost always
      // at the end, not the beginning, so a head-only truncation was systematically dropping the
      // part that mattered most on any output big enough to hit the cap.
      const headBytes = Math.min(Math.floor(maxOutputBytes * 0.2), buf.byteLength);
      const tailBytes = maxOutputBytes - headBytes;
      const head = buf.subarray(0, headBytes).toString("utf8");
      const tail = buf.subarray(buf.byteLength - tailBytes).toString("utf8");
      const omittedBytes = buf.byteLength - headBytes - tailBytes;
      return `${head}\n…(${omittedBytes} bytes omitted)…\n${tail}`;
    }

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");

    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });

    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        stdout: truncate(stdout),
        stderr: truncate(stderr + "\n" + err.message),
        code: 1,
        timedOut: killed,
      });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        stdout: truncate(stdout),
        stderr: truncate(stderr),
        code,
        timedOut: killed,
      });
    });
  });
}
