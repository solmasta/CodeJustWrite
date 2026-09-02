import { config as loadDotenv } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import os from "node:os";
import express from "express";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import { loadConfig } from "@codejustwrite/core";
import { loadServerConfig } from "./config.js";
import { requireAuth, checkWsToken } from "./auth.js";
import { SessionManager } from "./session.js";
import { listRepos } from "./github.js";
import { buildGoogleAuthUrl, exchangeCodeForRefreshToken, getAccessToken, ensureBackupFolder, uploadBackupFile } from "./googleDrive.js";

loadDotenv({ path: path.resolve(process.cwd(), ".env"), quiet: true });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webDist = path.join(__dirname, "..", "..", "web", "dist");

const serverConfig = loadServerConfig();
const agentConfig = loadConfig();

if (!serverConfig.authToken) {
  console.warn(
    "[cjw-server] WARNING: CJW_AUTH_TOKEN is not set. This server accepts requests from anyone who can " +
      "reach it, and it can run shell commands and push code. Set CJW_AUTH_TOKEN before deploying publicly."
  );
}

const workspacesDir = process.env.CJW_WORKSPACES_DIR || path.join(os.tmpdir(), "cjw-sessions");
const sessions = new SessionManager(workspacesDir, agentConfig, serverConfig.sessionTtlMs, serverConfig.maxSessions);

const app = express();
// Render (and most PaaS hosts) sit behind a reverse proxy — without this,
// req.ip is the proxy's address for every request, collapsing per-IP rate
// limiting into one shared bucket.
app.set("trust proxy", 1);

app.use(express.json({ limit: "100kb" }));

// CORS: bearer-token auth (not cookies) isn't vulnerable to CSRF, so an open
// origin is fine here and lets the PWA's "server URL" setting point at a
// backend on a different origin than the page itself.
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});

app.use((_req, res, next) => {
  res.header(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; img-src 'self' data:"
  );
  res.header("X-Frame-Options", "DENY");
  res.header("X-Content-Type-Options", "nosniff");
  res.header("Referrer-Policy", "no-referrer");
  next();
});

// Simple in-memory per-IP rate limit — not a substitute for CJW_AUTH_TOKEN,
// just extra friction against automated abuse of a discovered URL.
const rateLimits = new Map<string, { count: number; resetTime: number }>();
const RATE_LIMIT = 120;
const RATE_WINDOW_MS = 60_000;

app.use((req, res, next) => {
  const ip = req.ip || "unknown";
  const now = Date.now();
  const limit = rateLimits.get(ip);
  if (!limit || now > limit.resetTime) {
    rateLimits.set(ip, { count: 1, resetTime: now + RATE_WINDOW_MS });
  } else if (limit.count >= RATE_LIMIT) {
    res.status(429).json({ error: "Too many requests" });
    return;
  } else {
    limit.count++;
  }
  next();
});

app.get("/api/health", (_req, res) => {
  const mem = process.memoryUsage();
  res.json({
    ok: true,
    activeSessions: sessions.size,
    uptimeSec: Math.round(process.uptime()),
    memoryMb: Math.round(mem.heapUsed / 1024 / 1024),
  });
});

// Google's OAuth redirect is a plain browser navigation with no Authorization header, so these
// two can't sit behind the blanket bearer-auth below — they're registered ahead of it (same
// trick as /api/health above) and authenticate themselves instead: /connect requires the normal
// CJW_AUTH_TOKEN as a query param (the only way to send it on a plain link), and /callback trusts
// Google's echoed-back `state` to carry that same token through the round trip.
app.get("/api/google/connect", (req, res) => {
  if (!serverConfig.googleClientId || !serverConfig.googleClientSecret) {
    res.status(400).send("CJW_GOOGLE_CLIENT_ID / CJW_GOOGLE_CLIENT_SECRET are not configured on this server.");
    return;
  }
  const token = typeof req.query.token === "string" ? req.query.token : null;
  if (!checkWsToken(serverConfig.authToken, token)) {
    res.status(401).send("Unauthorized — open this link with ?token=<CJW_AUTH_TOKEN> appended.");
    return;
  }
  const redirectUri = `${req.protocol}://${req.get("host")}/api/google/callback`;
  const url = buildGoogleAuthUrl(
    { clientId: serverConfig.googleClientId, clientSecret: serverConfig.googleClientSecret },
    redirectUri,
    token ?? ""
  );
  res.redirect(url);
});

app.get("/api/google/callback", async (req, res) => {
  const code = typeof req.query.code === "string" ? req.query.code : null;
  const state = typeof req.query.state === "string" ? req.query.state : null;
  if (!checkWsToken(serverConfig.authToken, state)) {
    res.status(401).send("Unauthorized");
    return;
  }
  if (!code || !serverConfig.googleClientId || !serverConfig.googleClientSecret) {
    res.status(400).send("Missing authorization code or Google client credentials.");
    return;
  }
  try {
    const redirectUri = `${req.protocol}://${req.get("host")}/api/google/callback`;
    const refreshToken = await exchangeCodeForRefreshToken(
      { clientId: serverConfig.googleClientId, clientSecret: serverConfig.googleClientSecret },
      code,
      redirectUri
    );
    console.log("[cjw-server] Google Drive connected — refresh token obtained (value not logged).");
    res.send(
      "<html><body style=\"font-family:sans-serif;max-width:600px;margin:40px auto;line-height:1.5;\">" +
        "<h2>Google Drive connected</h2>" +
        "<p>Copy this refresh token and set it as the <code>CJW_GOOGLE_REFRESH_TOKEN</code> environment " +
        "variable on the server, then redeploy. Treat it like a password — anyone holding it can access " +
        "this Drive account's app-created backup files.</p>" +
        `<textarea readonly style="width:100%;height:80px;">${refreshToken}</textarea>` +
        "<p>Once that's set, this page and link are no longer needed.</p>" +
        "</body></html>"
    );
  } catch (err) {
    res.status(502).send(`Failed to connect Google Drive: ${err instanceof Error ? err.message : String(err)}`);
  }
});

app.use("/api", requireAuth(serverConfig.authToken));

app.get("/api/auth/status", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/github/repos", async (req, res) => {
  if (!agentConfig.githubToken) {
    res.status(400).json({ error: "GITHUB_TOKEN is not configured on the server." });
    return;
  }
  try {
    const query = typeof req.query.q === "string" ? req.query.q.toLowerCase() : "";
    const repos = await listRepos(agentConfig.githubToken);
    const filtered = query ? repos.filter((r) => r.fullName.toLowerCase().includes(query)) : repos;
    res.json({
      repos: filtered.map((r) => ({
        full_name: r.fullName,
        clone_url: r.cloneUrl,
        default_branch: r.defaultBranch,
        private: r.private,
        updated_at: r.updatedAt,
      })),
    });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/api/session/start", async (req, res) => {
  const { repoUrl, branch } = req.body ?? {};
  if (typeof repoUrl !== "string" || !repoUrl.trim()) {
    res.status(400).json({ error: "repoUrl is required" });
    return;
  }
  try {
    const session = await sessions.createSession(repoUrl.trim(), typeof branch === "string" ? branch : undefined);
    res.json({
      sessionId: session.id,
      repoRoot: session.repoRoot,
      provider: session.provider,
      model: session.model,
    });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.delete("/api/session/:id", async (req, res) => {
  await sessions.removeSession(req.params.id);
  res.json({ ok: true });
});

app.get("/api/google/status", (_req, res) => {
  res.json({ configured: !!(serverConfig.googleClientId && serverConfig.googleClientSecret && serverConfig.googleRefreshToken) });
});

app.post("/api/session/:id/backup", async (req, res) => {
  if (!serverConfig.googleClientId || !serverConfig.googleClientSecret || !serverConfig.googleRefreshToken) {
    res.status(400).json({ error: "Google Drive isn't connected on this server yet." });
    return;
  }
  const session = sessions.get(req.params.id);
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  const repoName =
    typeof req.body?.repoName === "string" && req.body.repoName.trim() ? req.body.repoName.trim() : "unknown-repo";
  try {
    const oauthConfig = { clientId: serverConfig.googleClientId, clientSecret: serverConfig.googleClientSecret };
    const accessToken = await getAccessToken(oauthConfig, serverConfig.googleRefreshToken);
    const folderId = await ensureBackupFolder(accessToken, repoName);
    const filename = `${new Date().toISOString().replace(/[:.]/g, "-")}.md`;
    const markdown = session.buildBackupMarkdown(repoName);
    const file = await uploadBackupFile(accessToken, folderId, filename, markdown);
    res.json({ webViewLink: file.webViewLink });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Serve the built PWA (apps/web/dist) and fall back to index.html for client-side routes.
app.use(express.static(webDist));
app.get(/^(?!\/api).*/, (_req, res) => {
  res.sendFile(path.join(webDist, "index.html"), (err) => {
    if (err) res.status(404).send("Web app not built yet — run `npm run build:web`.");
  });
});

const httpServer = createServer(app);
const wss = new WebSocketServer({ noServer: true });

// A backgrounded mobile tab (or a dropped cellular connection) can kill the underlying TCP
// connection without ever sending a clean close frame — the socket just goes silently dead,
// with WebSocketServer none the wiser and the client's own readyState still reporting "OPEN"
// indefinitely. Ping every connection on an interval and terminate any that didn't answer the
// previous round, so a dead session gets dropped (freeing session.ws, and firing the client's
// close handler if the connection can still deliver one) instead of sitting there as a phantom
// "connected" session forever. The client runs its own faster, foreground-triggered version of
// this same check (see apps/web/src/main.ts's checkConnectionAlive) for a snappier recovery the
// moment the app is reopened, rather than waiting out this interval.
const alive = new WeakSet<WebSocket>();
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!alive.has(ws)) {
      ws.terminate();
      continue;
    }
    alive.delete(ws);
    ws.ping();
  }
}, 30_000);
heartbeat.unref();

httpServer.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "", "http://localhost");
  if (url.pathname !== "/ws") {
    socket.destroy();
    return;
  }

  const token = url.searchParams.get("token");
  const sessionId = url.searchParams.get("sessionId");
  if (!checkWsToken(serverConfig.authToken, token) || !sessionId) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  const session = sessions.get(sessionId);
  if (!session) {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    session.attach(ws);
    alive.add(ws);
    ws.on("pong", () => alive.add(ws));

    ws.on("message", (raw) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        session.send({ type: "error", message: "Malformed message" });
        return;
      }
      session.touch();

      switch (msg.type) {
        // App-level liveness probe a client sends the moment it comes back to the foreground —
        // a plain protocol-level pong isn't reachable from browser JS, so this round trip is
        // what lets the client itself detect a connection that's gone silently dead. See
        // apps/web/src/main.ts's checkConnectionAlive.
        case "ping":
          ws.send(JSON.stringify({ type: "pong" }));
          break;
        case "user_message":
          void session.handleUserMessage(String(msg.text ?? ""));
          break;
        case "tool_decision":
          session.resolveConfirmation(String(msg.callId), Boolean(msg.approved));
          break;
        case "set_auto_approve":
          session.setAutoApprove(Boolean(msg.value));
          break;
        case "set_provider":
          session.setProvider(msg.provider === "openrouter" ? "openrouter" : "deepinfra");
          session.send({
            type: "state",
            provider: session.provider,
            model: session.model,
            autoApprove: session.autoApprove,
            repoRoot: session.repoRoot,
          });
          break;
        case "set_model":
          session.setModel(String(msg.model ?? session.model));
          break;
        case "set_prompt_mode":
          session.setPromptMode(
            String(msg.promptPreset ?? session.promptPreset),
            String(msg.customInstructions ?? session.customInstructions)
          );
          break;
        case "list_models": {
          const provider = msg.provider === "openrouter" ? "openrouter" : "deepinfra";
          session
            .listModels(provider)
            .then((models) => session.send({ type: "models", provider, models }))
            .catch((err) =>
              session.send({ type: "error", message: err instanceof Error ? err.message : String(err) })
            );
          break;
        }
        default:
          session.send({ type: "error", message: `Unknown message type: ${String(msg.type)}` });
      }
    });

    ws.on("close", () => session.detach(ws));
  });
});

process.on("SIGTERM", () => {
  console.log("[cjw-server] SIGTERM received, shutting down gracefully");
  wss.close();
  void sessions.closeMcp().finally(() => httpServer.close(() => process.exit(0)));
});

httpServer.listen(serverConfig.port, () => {
  console.log(`[cjw-server] listening on :${serverConfig.port} (web dist: ${webDist})`);
});
