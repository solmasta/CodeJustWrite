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

Or pick a provider/model at launch: `cjw --provider deepinfra --model meta-llama/Meta-Llama-3.1-70B-Instruct`

### Slash commands

```
/help                Show available commands
/provider <name>     Switch LLM provider: deepinfra | openrouter
/models [filter]     List models available from the current provider (live), e.g. /models claude
/model <name>         Switch model for the current provider
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
  find/replace), all confined to the repository root.
- **Git & GitHub** — `git_status`, `git_diff`, `git_create_branch`,
  `git_commit`, `git_merge`, `git_push`, and `create_pull_request` (uses the
  `gh` CLI when installed and authenticated, otherwise falls back to the
  GitHub REST API with a `GITHUB_TOKEN`).
- **Sandbox**
  - `run_shell` — constrained subprocess execution with a wall-clock timeout
    and truncated output.
  - `run_tests` — spins up a disposable `git worktree` carrying uncommitted
    changes, auto-detects npm/yarn/pnpm, installs deps, and runs the
    test/lint script there — the real working tree is never touched.
  - `browser_check` — drives headless Chromium via Playwright to a URL,
    performs click/fill/waitForSelector/evaluate actions, captures console
    errors, and saves a screenshot. Requires Chromium to actually be
    installed wherever the agent is running (`npx playwright install
    chromium`); the Docker image doesn't bundle it by default to keep the
    image small.

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
