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

// timeoutSec bounds wall-clock time, but nothing here bounds memory — a spawned command that
// balloons in RAM (an npm install/build, a test runner, whatever run_shell was told to run) can
// grow unchecked until it OOM-kills the whole container, taking the server process and every
// other active session down with it, well before its own timeout would ever fire. This can't
// cap non-JS memory (native buffers, other languages), but capping the *V8 heap* of a spawned
// command that happens to be — or itself spawns — a Node process (true for most installs/builds/
// test runners in this app) is the single highest-leverage guard available here. Only applied
// when the caller hasn't already set NODE_OPTIONS, and it's inherited by any Node process a
// script spawns in turn (e.g. an npm script's own child processes).
const DEFAULT_NODE_OPTIONS = "--max-old-space-size=300";

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
  const mergedEnv = { ...process.env, ...env };
  // Check the caller's own explicit override, not the merged env — the latter also carries
  // whatever NODE_OPTIONS this server's own host process happens to be running under, which would
  // otherwise silently defeat the cap for every single spawned command without any caller ever
  // having actually asked for that.
  if (!env?.NODE_OPTIONS) mergedEnv.NODE_OPTIONS = DEFAULT_NODE_OPTIONS;

  return new Promise((resolve) => {
    const child = args
      ? spawn(command, args, { cwd, env: mergedEnv })
      : spawn(command, { cwd, shell: true, env: mergedEnv });

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
