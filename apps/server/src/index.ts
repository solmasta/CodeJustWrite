import { config as loadDotenv } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import os from "node:os";
import express, { Request, Response, NextFunction } from "express";
import { WebSocketServer } from "ws";
import { loadConfig, type ProviderName } from "@codejustwrite/core";
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

// Rate limiting: map IP -> { count, resetTime }
const rateLimitMap = new Map<string, { count: number; resetTime: number }>();
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 60; // 60 requests per minute

function rateLimit(req: Request, res: Response, next: NextFunction): void {
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  const now = Date.now();
  
  const entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetTime) {
    rateLimitMap.set(ip, { count: 1, resetTime: now + RATE_LIMIT_WINDOW_MS });
    next();
    return;
  }
  
  entry.count++;
  if (entry.count > RATE_LIMIT_MAX_REQUESTS) {
    res.status(429).json({ error: "Rate limit exceeded. Try again later." });
    return;
  }
  next();
}

const app = express();
app.use(express.json());
app.use(rateLimit);

// Security headers
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-XSS-Protection", "1; mode=block");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  // CSP for PWA
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; img-src 'self' data:;"
  );
  next();
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, activeSessions: sessions.size });
});

app.use("/api", requireAuth(serverConfig.authToken));

app.get("/api/auth/status", (_req, res) => {
  res.json({
    authenticated: true,
    hasGithubToken: Boolean(agentConfig.githubToken),
  });
});

app.get("/api/repos", async (_req, res) => {
  if (!agentConfig.githubToken) {
    res.status(400).json({ error: "GITHUB_TOKEN is not configured on the server." });
    return;
  }
  try {
    const repos = await listRepos(agentConfig.githubToken);
    res.json({ repos });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/api/sessions", async (req, res) => {
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

app.delete("/api/sessions/:id", async (req, res) => {
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

// WebSocket rate limiting
const wsRateLimitMap = new Map<string, { count: number; resetTime: number }>();
const WS_RATE_LIMIT_WINDOW_MS = 60 * 1000;
const WS_RATE_LIMIT_MAX_MESSAGES = 100; // 100 messages per minute

httpServer.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "", "http://localhost");
  if (url.pathname !== "/ws") {
    socket.destroy();
    return;
  }

  // Get token from header instead of query param (more secure)
  const authHeader = req.headers["authorization"];
  const token = typeof authHeader === "string" && authHeader.startsWith("Bearer ") 
    ? authHeader.slice(7) 
    : url.searchParams.get("token"); // Fallback for backwards compatibility
    
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

  // Rate limit by IP
  const ip = req.socket.remoteAddress || "unknown";
  const now = Date.now();
  const entry = wsRateLimitMap.get(ip);
  if (!entry || now > entry.resetTime) {
    wsRateLimitMap.set(ip, { count: 1, resetTime: now + WS_RATE_LIMIT_WINDOW_MS });
  } else {
    entry.count++;
    if (entry.count > WS_RATE_LIMIT_MAX_MESSAGES) {
      socket.write("HTTP/1.1 429 Too Many Requests\r\n\r\n");
      socket.destroy();
      return;
    }
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    session.attach(ws);

    // Message size limit
    ws.on("message", (raw) => {
      // Reject messages > 100KB
      if (raw.length > 100 * 1024) {
        session.send({ type: "error", message: "Message too large (max 100KB)" });
        return;
      }
      
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
          session.setProvider(
            msg.provider === "deepinfra" || msg.provider === "openrouter"
              ? (msg.provider as ProviderName)
              : "openai"
          );
          session.send({ type: "state", provider: session.provider, model: session.model, autoApprove: session.autoApprove, repoRoot: session.repoRoot });
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

httpServer.listen(serverConfig.port, () => {
  console.log(`[cjw-server] listening on :${serverConfig.port} (web dist: ${webDist})`);
});
