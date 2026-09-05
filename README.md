# CodeJustWrite

An AI-assisted coding agent. It reads and writes files in a git repository,
runs the test suite in an isolated sandbox, drives a headless browser for UI
checks, and manages git branches/commits/merges and GitHub pull requests —
backed by **DeepInfra** or **OpenRouter** models.

It ships two ways to use the same agent:

- **`cjw`** — a terminal CLI that operates on your local checkout.
- **A phone-installable PWA** — a chat UI you add to your phone's home
  screen, talking to a small backend that clones a repo per session and runs
  the same agent/tools there.

## Monorepo layout

```
packages/core   shared agent: LLM providers, tool-calling loop, git/GitHub/
                shell/test/browser tools, sandbox — used by both apps below
apps/cli        the `cjw` terminal CLI
apps/server     backend for the PWA: auth, per-session repo clone, WebSocket
                bridge to the agent — also serves the built PWA
apps/web        the PWA itself (Vite): manifest + service worker + chat UI
```

## Quick start: terminal CLI

```bash
npm install
npm run build:core
npm run build:cli
npm link --workspace=@codejustwrite/cli   # optional: exposes `cjw` globally

cp apps/cli/.env.example apps/cli/.env
# fill in DEEPINFRA_KEY and/or OPENROUTER_KEY
```

From inside any git repository:

```bash
cjw
# or, without installing globally:
npm run dev:cli
```

Or pick a provider/model at launch: `cjw --provider deepinfra --model moonshotai/Kimi-K3`

### Slash commands

```
/help                Show available commands
/provider <name>     Switch LLM provider: deepinfra | openrouter
/models [filter]     List models available from the current provider (live), e.g. /models claude
/model <name>         Switch model for the current provider
/mode [preset]         Show or switch prompt style: default | tdd | explain | terse | security
/instructions [text]   Set (or, with no text, clear) custom instructions added to every reply
/mcp                  Show connected MCP servers and their tools
/diff                 Show git diff of the working tree
/status               Show git status
/commit <message>     Stage all changes and commit
/pr <title> | <body>  Open a pull request (title and body separated by '|')
/test [script]        Run the project's test suite in a sandbox worktree
/clear                Reset the conversation
/exit                 Quit
```

Anything else you type is sent to the agent, which can call any of the tools
below as needed.

### Switching models

Both providers' catalogs change over time, so rather than hardcode model IDs
that go stale, `/models` (CLI) and the model field's dropdown (PWA settings)
fetch the provider's live model list. `openrouter` proxies several hosted
Claude models under `anthropic/...` IDs alongside its other models — run
`/provider openrouter` (with `OPENROUTER_KEY` set), then `/models claude` to
see exactly which ones your OpenRouter account currently has access to, and
`/model <id>` to switch to one. Pricing and availability are set by
OpenRouter, not by this project.

### Prompt style and custom instructions

Beyond provider/model, you can switch how the agent *behaves* on the fly —
no restart needed, and it takes effect on the next reply without losing the
conversation so far:

- **Prompt style** — a small set of presets layered on top of the base
  system prompt (never replacing it, so the core safety rules like "don't
  push/merge without being asked" always still apply): `default`,
  `tdd` (write a failing test first), `explain` (narrate reasoning as it
  works), `terse` (minimal prose), `security` (extra scrutiny for
  injection/auth/secrets in every change).
- **Custom instructions** — free-text guidance of your own, appended after
  whichever preset is active (e.g. "always use tabs", "prefer functional
  components").

CLI: `/mode` (no argument) lists the presets and shows the current one,
`/mode tdd` switches; `/instructions <text>` sets custom instructions,
`/instructions` with nothing clears them. PWA: both live in **Settings (⚙)**
as a "Prompt style" dropdown and a "Custom instructions" text box.

## Quick start: phone PWA

The PWA is a static chat UI; it can't run git/shell itself, so a backend
does that on its behalf. Both live in this repo and deploy as one service.

### 1. Run the backend locally

```bash
npm install
npm run build:core
npm run build:web      # apps/server serves this build
cp apps/server/.env.example apps/server/.env
# fill in DEEPINFRA_KEY / OPENROUTER_KEY and set CJW_AUTH_TOKEN to a
# long random string — required for anything reachable off your machine
npm run dev:server     # http://localhost:8787
```

Open `http://localhost:8787` in a phone browser on the same network (or
`http://localhost:8787` on your own machine), enter the access token you set
above, paste a GitHub repo URL, and start a session.

### 2. Deploy it so your phone can reach it anywhere

Deploy the included `Dockerfile` to any container host. For
[Render](https://render.com):

1. Push this repo to GitHub.
2. In Render: **New → Blueprint**, point it at the repo (`render.yaml` is
   already set up).
3. Fill in the secrets Render prompts for: `CJW_AUTH_TOKEN` (make up a long
   random string), `DEEPINFRA_KEY`/`OPENROUTER_KEY`, and optionally
   `GITHUB_TOKEN` for PR creation without the `gh` CLI.
4. Once deployed, open the service's `https://…onrender.com` URL — that's
   both the API and the PWA.

Fly.io/Railway/any other Dockerfile host work the same way: build from the
root `Dockerfile`, exposing port `8787` (or your `$PORT`), with the same env
vars.

### 3. Install it on your phone

Open the deployed URL in Safari (iOS) or Chrome (Android):

- **iOS**: Share → **Add to Home Screen**
- **Android**: browser menu → **Install app** / **Add to Home screen**

It now opens full-screen like a native app. In the app: enter your access
token, then either tap **Browse my repos** to pick from the repos your
server's `GITHUB_TOKEN` can see, or paste a repo URL directly (and optional
branch). Tap **Start session** — the server clones that repo fresh for this
session. Chat with the agent from there; risky actions (writes, shell, git,
PR) show approve/deny buttons unless you flip **Auto-approve all actions**
on in settings (⚙).

**Working on multiple repos at once**: each browser tab tracks its own
session independently (via `sessionStorage`), so opening a second tab to the
same URL lands you back on the repo picker to start a separate session,
rather than taking over the first tab's. Your sign-in token and recent
repos are still shared across tabs — only the active session is per-tab.
Use **Settings (⚙) → Change Repository** to leave the current session and
pick a different one without signing out.

## Tools available to the agent

- **File tools** — `read_file`, `list_dir`, `write_file`, `edit_file` (unique
  find/replace), `delete_file`, all confined to the repository root.
- **search_files** — `git grep`-backed regex search across tracked and
  newly-created (not-yet-committed) files, automatically skipping whatever
  the repo's `.gitignore` skips. Read-only, no approval needed — the agent's
  main way to find where something is defined or used without reading files
  one at a time.
- **Git & GitHub** — `git_status`, `git_diff`, `git_log`, `git_stash`,
  `git_stash_pop`, `git_create_branch`, `git_fetch`, `git_checkout`,
  `git_commit`, `git_merge`, `git_merge_abort`, `git_push`,
  `create_pull_request`, `merge_pull_request`, and `get_pull_request_status`
  (checks/mergeability — read-only). The PR tools use the `gh` CLI when
  installed and authenticated, otherwise fall back to the GitHub REST API
  with a `GITHUB_TOKEN`. `git_merge` automatically deepens a shallow clone's
  history and retries once if that's the only reason two branches look
  unrelated.
- **Sandbox**
  - `run_shell` — constrained subprocess execution with a wall-clock timeout
    and truncated output.
  - `run_tests` — spins up a disposable `git worktree` carrying uncommitted
    changes, auto-detects the ecosystem from its manifest — `package.json`
    (npm/yarn/pnpm), `Cargo.toml` (`cargo test`), `go.mod` (`go test`), or
    `pyproject.toml`/`requirements.txt`/`setup.py` (`pytest`, installing deps
    first) — and runs its test/lint step there; the real working tree is
    never touched. For Node, also installs a subdirectory's own dependencies
    when the script just `cd`s into one (common in repos that aren't a
    formal npm/yarn/pnpm workspace, e.g. `"test": "cd frontend && npm
    test"`), and retries a failed npm install with `--legacy-peer-deps` on a
    peer-dependency conflict.
  - `browser_check` — drives headless Chromium via Playwright to a URL,
    performs click/fill/waitForSelector/evaluate actions, captures console
    errors, and saves a screenshot. The screenshot is also attached directly
    to the next model turn as an image (vision-capable models only) — so a
    layout/styling bug that never throws a console error can still be
    caught, not just confirmed to have loaded. The Docker image installs
    Chromium at build time (`playwright install --with-deps chromium`); a
    non-Docker deploy needs to run that manually.

## Performance and token usage

- **Parallel tool calls**: when a model requests several tools in one turn
  that are safe to run together, they run concurrently instead of one at a
  time — either all *read-only* (`read_file`, `list_dir`, `search_files`,
  `git_status`, `git_diff`, `git_log`, `get_pull_request_status` — no side
  effects, no ordering dependency on each other), or read-only calls plus
  at most one *isolated-resource* call (`run_tests`, `browser_check` — no
  confirmation gate, and each works against its own private resource — a
  temp worktree, a fresh browser instance — that can't collide with a
  read-only look at the live tree). Anything that writes, mutates git
  state, or needs confirmation always keeps its whole batch sequential —
  including two writes to different files: a confirmation is an
  interactive gate, and the CLI's prompt can only have one question
  pending at a time, so two at once would break rather than just be
  awkward. This cuts wall-clock latency for investigation-heavy turns —
  it does not reduce token usage, since the model still only sees one
  round of results either way.
- **Token usage** is dominated by the full conversation history being resent
  on every turn, so the levers are:
  1. **Automatic history compaction** — once the resent history's total
     size crosses a threshold (150KB by default, roughly 37K tokens), older
     large tool-call results and screenshots get replaced with a short
     placeholder (never the system prompt, and never anything from the most
     recent ~12 messages — recent context is what the model actually needs
     right now). A tool-result message is always shrunk in place, never
     removed outright, since every one has to stay paired with its
     assistant message's tool call for the wire format to stay valid.
  2. **Provider-side prompt caching** on that resent prefix — both
     DeepInfra and OpenRouter discount repeated input tokens heavily
     (DeepInfra's cached-input pricing ran roughly 80-92% off standard
     input for the models checked at the time of writing), and this
     project's history is append-only with a stable prefix, so it should
     already benefit without any special handling.
  3. **Output caps** — `run_shell`/`run_tests` cap combined stdout+stderr at
     100KB by default, keeping the first ~20% and the *last* ~80% of that
     budget rather than a single head-only cut, since a command's actually
     useful content (a test summary, "N failed", the final error) is
     almost always at the end of its output, not the beginning.
- Use `/clear` (CLI) or starting a new session (PWA) to reset the
  conversation entirely once a long session's resent history stops being
  worth its token cost even after compaction.

### MCP connectors (static API key/token)

Beyond the built-in tools above, the agent can attach external [MCP]
(Model Context Protocol) servers as extra tools — the same mechanism behind
connectors like GitHub or Render. This first cut covers servers authenticated
with a static credential (an API key or token you already have), not OAuth.

Set `CJW_MCP_SERVERS` to a JSON array, one entry per server:

```json
[
  {
    "name": "github",
    "transport": "stdio",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-github"],
    "apiKey": "ghp_...",
    "apiKeyEnvVar": "GITHUB_PERSONAL_ACCESS_TOKEN"
  },
  {
    "name": "render",
    "transport": "http",
    "url": "https://mcp.render.com/mcp",
    "apiKey": "rnd_..."
  }
]
```

- `transport: "stdio"` spawns `command`/`args` as a subprocess and speaks MCP
  over its stdin/stdout; `apiKey` is passed to it as an environment variable
  (`apiKeyEnvVar`, default `API_KEY`) — the pattern most official MCP servers
  expect.
- `transport: "http"` connects to a remote MCP server's Streamable HTTP
  endpoint; `apiKey` (if set) is sent as `Authorization: Bearer <apiKey>`.
- Each server's tools appear to the agent as `mcp_<name>_<tool>` and require
  approval like the built-in git/shell/PR tools do, unless the server itself
  marks a tool read-only.
- A server that fails to connect (bad command, unreachable URL, wrong key)
  is skipped with a logged warning rather than breaking the rest of the
  agent's tools — check `/mcp` (CLI) or the server's startup log for status.

### When a model doesn't actually call tools

Some models — especially smaller or older ones — don't reliably use the
API's real function-calling mechanism even when given the full tool list:
instead of a proper tool call, they write a plain-text reply whose entire
content is just what a tool call *would* look like (e.g.
`{"name": "list_dir", "arguments": {"path": "."}}`, or the same thing
wrapped in `{"type": "function", ...}` or a markdown code fence). Left
alone, that's a silent failure — the API sees an ordinary finished turn, so
nothing executes and the conversation stalls with the raw JSON as the
"answer" instead of real results. The agent recognizes that specific shape
(only when the name matches a real registered tool, so it never swallows a
genuine answer that happens to include a JSON example) and runs it as if it
had been a real tool call. If you see this happening often, it's a sign the
current model isn't a great fit for this agent — switch to one with
stronger tool-calling via `/models` (CLI) or the model dropdown (PWA
settings).

## Development

```bash
npm run build        # build core, cli, server, web in order
npm run typecheck     # tsc --noEmit across core/cli/server
npm run lint          # eslint across all workspaces
npm test              # vitest for packages/core (unit tests only; no network/API calls)
npm run dev:cli        # run the CLI from source via tsx
npm run dev:server     # run the backend from source via tsx, with reload
npm run dev:web        # run the PWA dev server (proxies /api and /ws to :8787)
```

## Safety notes

- `run_shell` sandboxing is a **resource limiter** (timeout + output cap +
  cwd confinement), not a full security sandbox — it does not isolate
  filesystem or network access the way a container would.
- File tools refuse to read or write outside the repository (or, for the
  server, the per-session clone) root.
- The agent's system prompt instructs it not to commit, merge, push, or open
  a PR unless asked for that outcome in the conversation, and every such
  tool call still requires approval (a terminal `y/N` prompt in the CLI, an
  approve/deny button in the PWA) unless auto-approve is explicitly enabled.
- The PWA backend can run shell commands and push code on your behalf.
  **Always set `CJW_AUTH_TOKEN`** on any deploy reachable from the internet
  — without it, anyone with the URL can use it.
- Each PWA session clones its repo into its own disposable workspace
  (default: OS temp dir, cleaned up when the session ends or goes idle past
  `CJW_SESSION_TTL_MIN`), so sessions don't share state or history.
- MCP connector tools (`CJW_MCP_SERVERS`) are third-party code the agent can
  call — they require approval by default, same as the built-in git/shell/PR
  tools, unless the server marks a tool read-only. A stdio connector's
  `apiKey` is only ever passed to that connector's own subprocess as an env
  var; an http connector's `apiKey` is only ever sent to that connector's own
  URL as a bearer token.
