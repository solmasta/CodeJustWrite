import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

/** Written once per install to <userData>/config.env, then left alone — the desktop app never
 *  overwrites it after creation, so edits survive updates/restarts. Mirrors the handful of
 *  settings a desktop user would plausibly want to change; everything else (auth token, port,
 *  workspace dir) is managed by the app itself and never exposed here, since getting one of
 *  those wrong would just break the app rather than being a preference worth exposing. */
const CONFIG_TEMPLATE = `# CodeJustWrite desktop settings — edit, save, then use
# CodeJustWrite > Restart Server (or quit and reopen the app) to apply.

# Local model server (Ollama by default). Only change this if you're not
# using Ollama, or it's not running on the default port.
CJW_LOCAL_BASE_URL=http://localhost:11434/v1

# Must already be \`ollama pull\`ed.
CJW_DEFAULT_MODEL=qwen2.5-coder:14b

# Optional: lets the agent push branches and open/merge PRs without the
# \`gh\` CLI. Create one at https://github.com/settings/tokens
GITHUB_TOKEN=

# Optional: JSON array of MCP servers to attach as extra tools. See the
# project README for the stdio/http shape.
CJW_MCP_SERVERS=
`;

export interface UserConfig {
  localBaseUrl?: string;
  defaultModel?: string;
  githubToken?: string;
  mcpServers?: string;
}

/** Creates the user-editable settings file on first launch. Never touches it again — an existing
 *  file (including one a user emptied or broke) is left exactly as they left it. */
export function ensureUserConfigFile(configPath: string): void {
  if (!existsSync(configPath)) writeFileSync(configPath, CONFIG_TEMPLATE, { mode: 0o600 });
}

/** Minimal KEY=VALUE parser (no quoting/escaping, no multiline values) — deliberately not a full
 *  dotenv implementation, since this file is small and hand-edited, not generated. Blank lines
 *  and #-comments are skipped; anything else without an '=' is ignored rather than throwing, so a
 *  stray typo doesn't stop the app from starting. */
export function parseUserConfig(raw: string): UserConfig {
  const out: UserConfig = {};
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (key === "CJW_LOCAL_BASE_URL") out.localBaseUrl = value;
    else if (key === "CJW_DEFAULT_MODEL") out.defaultModel = value;
    else if (key === "GITHUB_TOKEN") out.githubToken = value;
    else if (key === "CJW_MCP_SERVERS") out.mcpServers = value;
  }
  return out;
}

export function loadUserConfig(configPath: string): UserConfig {
  try {
    return parseUserConfig(readFileSync(configPath, "utf8"));
  } catch {
    return {};
  }
}

export function generateAuthToken(): string {
  return randomBytes(24).toString("base64url");
}

/** Tries the preferred port first (so the URL stays predictable across launches when nothing
 *  else is using it); falls back to whatever the OS hands out on EADDRINUSE, since a second
 *  CodeJustWrite window or an unrelated app squatting on 8787 shouldn't stop this one from
 *  starting. */
export function findFreePort(preferred: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code !== "EADDRINUSE") {
        reject(err);
        return;
      }
      const fallback = createServer();
      fallback.unref();
      fallback.on("error", reject);
      fallback.listen(0, "127.0.0.1", () => {
        const address = fallback.address();
        const port = typeof address === "object" && address ? address.port : preferred;
        fallback.close(() => resolve(port));
      });
    });
    server.listen(preferred, "127.0.0.1", () => {
      server.close(() => resolve(preferred));
    });
  });
}

export interface ServerEnvOptions {
  port: number;
  authToken: string;
  workspacesDir: string;
  webDistDir: string;
  userConfig: UserConfig;
}

/** Builds the full env for the spawned server process — the parent's own env (PATH, HOME, etc.,
 *  needed for git/node to work as subprocesses of *that*) plus everything CodeJustWrite reads,
 *  with the app-managed values (host/port/token/workspace dir) always winning over anything a
 *  user might have set in their shell, since those aren't meant to be configurable here. */
export function buildServerEnv(base: NodeJS.ProcessEnv, opts: ServerEnvOptions): NodeJS.ProcessEnv {
  return {
    ...base,
    CJW_LOCAL_BASE_URL: opts.userConfig.localBaseUrl || "http://localhost:11434/v1",
    CJW_DEFAULT_MODEL: opts.userConfig.defaultModel || "qwen2.5-coder:14b",
    GITHUB_TOKEN: opts.userConfig.githubToken || "",
    CJW_MCP_SERVERS: opts.userConfig.mcpServers || "",
    // Always after the user-config spread above: never overridable from config.env.
    CJW_HOST: "127.0.0.1",
    PORT: String(opts.port),
    CJW_AUTH_TOKEN: opts.authToken,
    CJW_WORKSPACES_DIR: opts.workspacesDir,
    CJW_WEB_DIST: opts.webDistDir,
  };
}
