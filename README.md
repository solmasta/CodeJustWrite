# CodeJustWrite

A terminal-based, AI-assisted coding agent. It reads and writes files in your
git repository, runs your test suite in an isolated sandbox, drives a
headless browser for UI checks, and manages git branches/commits/merges and
GitHub pull requests — all from an interactive CLI session backed by either
**OpenAI** or **DeepInfra** models.

## Features

- **Dual LLM backends** — OpenAI and DeepInfra, both spoken as OpenAI-compatible
  chat-completions APIs. Switch providers/models mid-session with `/provider`
  and `/model`.
- **File tools** — `read_file`, `list_dir`, `write_file`, `edit_file` (unique
  find/replace), all confined to the repository root.
- **Git & GitHub** — `git_status`, `git_diff`, `git_create_branch`,
  `git_commit`, `git_merge`, `git_push`, and `create_pull_request` (uses the
  `gh` CLI when installed and authenticated, otherwise falls back to the
  GitHub REST API with a `GITHUB_TOKEN`).
- **Sandbox**
  - `run_shell` — constrained subprocess execution with a wall-clock timeout
    and truncated output.
  - `run_tests` — spins up a disposable `git worktree` carrying your
    uncommitted changes, auto-detects npm/yarn/pnpm, installs deps, and runs
    your test/lint script there — your real working tree is never touched.
  - `browser_check` — drives headless Chromium via Playwright to a URL,
    performs click/fill/waitForSelector/evaluate actions, captures console
    errors, and saves a screenshot under `.cjw/screenshots/`.
- **Confirmation gate** — every mutating tool (writes, shell exec, git
  mutations, PR creation) asks for a `y/N` confirmation in the terminal
  before running.

## Install

```bash
npm install
npm run build
npm link   # optional: exposes the `cjw` command globally
```

## Configure

```bash
cp .env.example .env
```

Fill in at least one of `OPENAI_API_KEY` / `DEEPINFRA_API_KEY`. Set
`GITHUB_TOKEN` only if you don't have the `gh` CLI installed/authenticated —
it's used solely as a fallback for opening pull requests.

## Run

From inside any git repository:

```bash
cjw
# or, without installing globally:
npm run dev
```

Or pick a provider/model at launch:

```bash
cjw --provider deepinfra --model meta-llama/Meta-Llama-3.1-70B-Instruct
```

### Slash commands

```
/help                Show available commands
/provider <name>     Switch LLM provider: openai | deepinfra
/model <name>         Switch model for the current provider
/diff                 Show git diff of the working tree
/status               Show git status
/commit <message>     Stage all changes and commit
/pr <title> | <body>  Open a pull request (title and body separated by '|')
/test [script]        Run the project's test suite in a sandbox worktree
/clear                Reset the conversation
/exit                 Quit
```

Anything else you type is sent to the agent, which can call any of the tools
above as needed — reading files to understand the codebase, editing them,
running the sandboxed test suite, and opening a PR once you ask it to.

## Development

```bash
npm run dev        # run the CLI from source via tsx
npm run typecheck  # tsc --noEmit
npm run lint       # eslint
npm test           # vitest (unit tests only; no network/API calls)
npm run build      # compile to dist/
```

## Safety notes

- `run_shell` sandboxing is a **resource limiter** (timeout + output cap +
  cwd confinement), not a full security sandbox — it does not isolate
  filesystem or network access the way a container would. Review the
  confirmation prompt before approving commands from an untrusted prompt.
- File tools refuse to read or write outside the repository root.
- The agent will not commit, merge, push, or open a PR unless you've asked
  for that outcome in the conversation (see `SYSTEM_PROMPT` in
  `src/agent/systemPrompt.ts`), and every such tool call still requires your
  `y/N` confirmation regardless.
