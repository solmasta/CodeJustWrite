import { config as loadDotenv } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import os from "node:os";
import express from "express";
import { WebSocketServer } from "ws";
import { loadConfig } from "@codejustwrite/core";
import { loadServerConfig } from "./config.js";
import { requireAuth, checkWsToken } from "./auth.js";
import { SessionManager } from "./session.js";
import { listRepos } from "./github.js";

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

// Serve the built PWA (apps/web/dist) and fall back to index.html for client-side routes.
app.use(express.static(webDist));
app.get(/^(?!\/api).*/, (_req, res) => {
  res.sendFile(path.join(webDist, "index.html"), (err) => {
    if (err) res.status(404).send("Web app not built yet — run `npm run build:web`.");
  });
});

const httpServer = createServer(app);
const wss = new WebSocketServer({ noServer: true });

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
  httpServer.close(() => process.exit(0));
});

httpServer.listen(serverConfig.port, () => {
  console.log(`[cjw-server] listening on :${serverConfig.port} (web dist: ${webDist})`);
});
