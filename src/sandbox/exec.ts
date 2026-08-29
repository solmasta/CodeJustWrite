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
 * Runs a shell command as a constrained subprocess: bounded wall-clock
 * timeout, output truncation, and a cwd confined to the caller's workspace.
 * This is a resource-limiting sandbox, not a security boundary — it does
 * not isolate filesystem/network access the way a container would.
 */
export function execSandboxed(command: string, opts: ExecOptions): Promise<ExecResult> {
  const maxBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      shell: true,
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutSec * 1000);

    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < maxBytes) stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < maxBytes) stderr += chunk.toString();
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        stdout: stdout.slice(0, maxBytes),
        stderr: stderr.slice(0, maxBytes),
        code,
        timedOut,
      });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: `${stderr}\n${String(err)}`, code: null, timedOut });
    });
  });
}
