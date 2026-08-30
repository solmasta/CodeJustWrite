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

const DEFAULT_MAX_OUTPUT_BYTES = 200_000;

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
      if (Buffer.byteLength(str, "utf8") <= maxOutputBytes) return str;
      // Trim to byte limit, preserving valid UTF-8
      const buf = Buffer.from(str, "utf8");
      return buf.subarray(0, maxOutputBytes).toString("utf8") + "\n…(truncated)";
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
