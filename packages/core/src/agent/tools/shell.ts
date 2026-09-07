import { execSandboxed } from "../../sandbox/exec.js";
import { heavyOperationLock } from "../../sandbox/heavyOpLock.js";
import type { ToolDefinition } from "./types.js";

export const runShellTool: ToolDefinition = {
  spec: {
    name: "run_shell",
    description:
      "Run a shell command in the repository root, sandboxed with a wall-clock timeout and truncated output. Use for installs, builds, one-off scripts. Prefer run_tests for the project's test suite.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The shell command to run." },
      },
      required: ["command"],
    },
  },
  requiresConfirmation: true,
  run(args, ctx) {
    // Serialized process-wide (see heavyOpLock.ts): an arbitrary shell command — an npm
    // install, a build — can use as much real RSS as its own --max-old-space-size cap allows,
    // on top of everything else already running in this container, so two sessions' commands
    // can't be allowed to stack.
    return heavyOperationLock.run(async () => {
      const command = String(args.command);
      const result = await execSandboxed(command, {
        cwd: ctx.repoRoot,
        timeoutSec: ctx.config.shellTimeoutSec,
      });
      const status = result.timedOut
        ? `TIMED OUT after ${ctx.config.shellTimeoutSec}s`
        : `exit code ${result.code}`;
      return [`$ ${command}`, `(${status})`, "--- stdout ---", result.stdout, "--- stderr ---", result.stderr].join(
        "\n"
      );
    });
  },
};
