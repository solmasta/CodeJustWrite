import { spawn, type ChildProcess } from "node:child_process";

export class ServerStartError extends Error {}

export interface SpawnServerOptions {
  /** Path to the server's built entry point (dist/index.js). */
  entryPath: string;
  env: NodeJS.ProcessEnv;
  /** Path to the Node executable to run it with — Electron's own binary in production (run as
   *  plain Node via ELECTRON_RUN_AS_NODE, so packaged users don't need Node installed
   *  separately), or the system `node` in dev. */
  execPath: string;
  onLog: (line: string, stream: "stdout" | "stderr") => void;
  onExit: (code: number | null, signal: NodeJS.Signals | null) => void;
}

export function spawnServer(opts: SpawnServerOptions): ChildProcess {
  const child = spawn(opts.execPath, [opts.entryPath], {
    env: { ...opts.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
    for (const line of chunk.split("\n")) if (line) opts.onLog(line, "stdout");
  });
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
    for (const line of chunk.split("\n")) if (line) opts.onLog(line, "stderr");
  });
  child.on("exit", (code, signal) => opts.onExit(code, signal));
  return child;
}

/** Polls /api/health until the server answers or the timeout elapses — spawning a process
 *  doesn't mean it's accepting connections yet (Node startup, port bind, route registration all
 *  take a moment), and loading the window before that just shows a connection-refused page. */
export async function waitForHealth(baseUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return;
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new ServerStartError(
    `The local server didn't come up within ${Math.round(timeoutMs / 1000)}s` +
      (lastError instanceof Error ? `: ${lastError.message}` : "")
  );
}
