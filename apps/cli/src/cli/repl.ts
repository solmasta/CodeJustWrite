import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import chalk from "chalk";
import {
  Agent,
  ProviderRegistry,
  allTools,
  buildSystemPrompt,
  connectMcpServers,
  defaultModelFor,
  execSandboxed,
  log,
  DEFAULT_PROMPT_PRESET_ID,
  PROMPT_PRESETS,
  type CjwConfig,
  type ProviderName,
  type ToolContext,
} from "@codejustwrite/core";

const HELP_TEXT = `
Slash commands:
  /help                Show this help
  /provider <name>     Switch LLM provider: deepinfra | openrouter
  /models [filter]     List models available from the current provider (live), e.g. /models claude
  /model <name>        Switch model for the current provider
  /mode [preset]        Show or switch prompt style (default | tdd | explain | terse | security)
  /instructions [text]  Set (or, with no text, clear) custom instructions added to every reply
  /mcp                  Show connected MCP servers and their tools
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

  const state = {
    provider: config.provider as ProviderName,
    model: config.model,
    promptPreset: DEFAULT_PROMPT_PRESET_ID,
    customInstructions: "",
  };

  const ctx: ToolContext = {
    repoRoot,
    config,
    log: (line: string) => log.diff(line),
    confirm: async (question: string) => {
      const answer = (await rl.question(chalk.yellow(`${question} [y/N] `))).trim().toLowerCase();
      return answer === "y" || answer === "yes";
    },
  };

  const mcp = await connectMcpServers(config.mcpServers);
  for (const status of mcp.statuses) {
    if (status.connected) {
      log.dim(`[mcp] ${status.name}: connected (${status.toolCount} tool(s))`);
    } else {
      log.error(`[mcp] ${status.name}: failed to connect — ${status.error}`);
    }
  }

  const agent = new Agent({
    getProvider: () => registry.get(state.provider),
    getModel: () => state.model,
    ctx,
    tools: [...allTools, ...mcp.tools],
    systemPrompt: buildSystemPrompt(state.promptPreset, state.customInstructions),
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
      await mcp.close();
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
        await mcp.close();
        return;
      } else if (cmd === "mcp") {
        if (!mcp.statuses.length) {
          log.info("No MCP servers configured (set CJW_MCP_SERVERS to add some).");
        } else {
          log.info(
            mcp.statuses
              .map((s) => (s.connected ? `${s.name}: connected (${s.toolCount} tool(s))` : `${s.name}: failed — ${s.error}`))
              .join("\n")
          );
        }
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
      } else if (cmd === "models") {
        try {
          const models = await registry.get(state.provider).listModels();
          const filtered = arg
            ? models.filter((m) => m.id.toLowerCase().includes(arg.toLowerCase()))
            : models;
          if (!filtered.length) {
            log.info(arg ? `No models matching "${arg}" for ${state.provider}.` : `No models returned by ${state.provider}.`);
          } else {
            log.info(`${filtered.length} model(s) for ${state.provider}:\n` + filtered.map((m) => `  ${m.id}`).join("\n"));
          }
        } catch (err) {
          log.error(`Couldn't list models: ${err instanceof Error ? err.message : String(err)}`);
        }
      } else if (cmd === "model") {
        if (!arg) {
          log.error("Usage: /model <model-name>");
        } else {
          state.model = arg;
          log.success(`Model set to ${state.model}`);
        }
      } else if (cmd === "mode") {
        if (!arg) {
          log.info(
            `Current: ${state.promptPreset}\n` +
              PROMPT_PRESETS.map((p) => `  ${p.id}${p.id === state.promptPreset ? " (current)" : ""} — ${p.description}`).join(
                "\n"
              )
          );
        } else if (!PROMPT_PRESETS.some((p) => p.id === arg)) {
          log.error(`Unknown mode "${arg}". Run /mode with no argument to see the list.`);
        } else {
          state.promptPreset = arg;
          agent.setSystemPrompt(buildSystemPrompt(state.promptPreset, state.customInstructions));
          log.success(`Prompt style set to ${state.promptPreset}`);
        }
      } else if (cmd === "instructions") {
        state.customInstructions = arg;
        agent.setSystemPrompt(buildSystemPrompt(state.promptPreset, state.customInstructions));
        log.success(arg ? `Custom instructions set.` : "Custom instructions cleared.");
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
