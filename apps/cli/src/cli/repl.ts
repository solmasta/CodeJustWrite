import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import chalk from "chalk";
import {
  Agent,
  ProviderRegistry,
  defaultModelFor,
  execSandboxed,
  log,
  type CjwConfig,
  type ProviderName,
  type ToolContext,
} from "@codejustwrite/core";

const HELP_TEXT = `
Slash commands:
  /help                Show this help
  /provider <name>     Switch LLM provider: deepinfra | openrouter
  /model <name>        Switch model for the current provider
  /diff                Show git diff of the working tree
  /status              Show git status
  /commit <message>    Stage all changes and commit
  /pr <title> | <body> Open a pull request (title and body separated by '|')
  /test [script]        Run the project's test suite in a sandbox worktree
  /clear                Reset the conversation
  /exit                 Quit
`;

async function assertGitRepo(rl: readline.Interface): Promise<string> {
  const result = await execSandboxed("git rev-parse --show-toplevel", { cwd: process.cwd(), timeoutSec: 10 });
  if (result.code !== 0) {
    log.error("Not inside a git repository. cd into your project first.");
    rl.close();
    process.exit(1);
  }
  return result.stdout.trim();
}

export async function runRepl(config: CjwConfig): Promise<void> {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  const repoRoot = await assertGitRepo(rl);
  const registry = new ProviderRegistry(config);

  const state = { provider: config.provider as ProviderName, model: config.model };

  const ctx: ToolContext = {
    repoRoot,
    config,
    log: (line: string) => log.diff(line),
    confirm: async (question: string) => {
      const answer = (await rl.question(chalk.yellow(`${question} [y/N] `))).trim().toLowerCase();
      return answer === "y" || answer === "yes";
    },
  };

  const agent = new Agent({
    getProvider: () => registry.get(state.provider),
    getModel: () => state.model,
    ctx,
    onTextDelta: (delta) => log.assistant(delta),
    onToolCall: (name, args) => log.tool(`\n→ ${name}(${JSON.stringify(args)})`),
    onToolResult: (name, result, isError) => {
      const preview = result.length > 2000 ? result.slice(0, 2000) + "\n… (truncated)" : result;
      (isError ? log.error : log.dim)(`  ${isError ? "✗" : "✓"} ${name}:\n${preview}`);
    },
  });

  log.info(`CodeJustWrite — ${state.provider}:${state.model} — repo: ${repoRoot}`);
  log.dim(`Type /help for commands, /exit to quit.`);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    let input: string;
    try {
      input = (await rl.question(chalk.bold("\nyou> "))).trim();
    } catch {
      // stdin closed (e.g. Ctrl+D, or piped input ran out) — exit gracefully.
      log.dim("\nGoodbye.");
      return;
    }
    if (!input) continue;

    if (input.startsWith("/")) {
      const [cmd, ...rest] = input.slice(1).split(" ");
      const arg = rest.join(" ").trim();

      if (cmd === "help") {
        log.info(HELP_TEXT);
      } else if (cmd === "exit" || cmd === "quit") {
        rl.close();
        return;
      } else if (cmd === "clear") {
        agent.reset();
        log.info("Conversation cleared.");
      } else if (cmd === "provider") {
        if (arg !== "deepinfra" && arg !== "openrouter") {
          log.error("Usage: /provider deepinfra|openrouter");
        } else {
          state.provider = arg;
          state.model = defaultModelFor(arg);
          log.success(`Switched to ${state.provider}:${state.model}`);
        }
      } else if (cmd === "model") {
        if (!arg) {
          log.error("Usage: /model <model-name>");
        } else {
          state.model = arg;
          log.success(`Model set to ${state.model}`);
        }
      } else if (cmd === "diff") {
        const result = await execSandboxed("git diff HEAD", { cwd: repoRoot, timeoutSec: 15 });
        log.diff(result.stdout || "(no changes)");
      } else if (cmd === "status") {
        const result = await execSandboxed("git status --short --branch", { cwd: repoRoot, timeoutSec: 15 });
        log.info(result.stdout || "(clean)");
      } else if (cmd === "commit") {
        if (!arg) {
          log.error("Usage: /commit <message>");
        } else {
          const add = await execSandboxed("git add -A", { cwd: repoRoot, timeoutSec: 15 });
          if (add.code !== 0) log.error(add.stderr);
          const escaped = arg.replace(/"/g, '\\"');
          const commit = await execSandboxed(`git commit -m "${escaped}"`, { cwd: repoRoot, timeoutSec: 15 });
          (commit.code === 0 ? log.success : log.error)(commit.stdout || commit.stderr);
        }
      } else if (cmd === "pr") {
        const [title, body] = arg.split("|").map((s) => s.trim());
        if (!title) {
          log.error("Usage: /pr <title> | <body>");
        } else {
          await agent.send(
            `Open a pull request with title "${title}" and body "${body ?? ""}" from the current branch.`
          );
        }
      } else if (cmd === "test") {
        await agent.send(`Run the project's test suite${arg ? ` (script: ${arg})` : ""} in the sandbox.`);
      } else {
        log.error(`Unknown command: /${cmd}. Type /help for a list.`);
      }
      continue;
    }

    try {
      log.assistant("\nassistant> ");
      await agent.send(input);
      log.assistant("\n");
    } catch (err) {
      log.error(`\nError: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
