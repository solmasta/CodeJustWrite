import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import { SessionManager } from "./session";
import { withAuth, requireToken, TokenData } from "./auth";
import { getSecret } from "./secrets";
import { createServer } from "http";
import { resolve } from "path";
import { existsSync } from "fs";
import type { IncomingMessage } from "http";
import type { Duplex } from "stream";

// Structured logging with levels
enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
  AUDIT = 4,
}

const LOG_LEVEL_NAMES = ["DEBUG", "INFO", "WARN", "ERROR", "AUDIT"];

function log(level: LogLevel, data: Record<string, unknown>): void {
  const entry = {
    timestamp: new Date().toISOString(),
    level: LOG_LEVEL_NAMES[level],
    ...data,
  };
  console.log(JSON.stringify(entry));
}

function logRequest(req: express.Request, status: number, duration: number): void {
  log(LogLevel.INFO, {
    type: "http_request",
    method: req.method,
    path: req.path,
    status,
    duration: `${duration}ms`,
    ip: req.ip,
    userAgent: req.headers["user-agent"],
  });
}

function logAudit(action: string, data: Record<string, unknown>): void {
  log(LogLevel.AUDIT, { type: "audit", action, ...data });
}

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });

app.use(express.json({ limit: "100kb" }));

// Security headers
app.use((req, res, next) => {
  res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:;");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  next();
});

// Simple rate limiter with cleanup
interface RateLimitEntry {
  count: number;
  resetTime: number;
}

const rateLimitMap = new Map<string, RateLimitEntry>();

function checkRateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(key);
  
  if (!entry || now > entry.resetTime) {
    rateLimitMap.set(key, { count: 1, resetTime: now + windowMs });
    return true;
  }
  
  if (entry.count >= limit) {
    return false;
  }
  
  entry.count++;
  return true;
}

// Clean up expired entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  for (const [key, entry] of rateLimitMap.entries()) {
    if (now > entry.resetTime) {
      rateLimitMap.delete(key);
      cleaned++;
    }
  }
  if (cleaned > 0) {
    log(LogLevel.INFO, { type: "rate_limit_cleanup", removed: cleaned });
  }
}, 5 * 60 * 1000);

// HTTP rate limiting (60 requests per minute per IP)
app.use((req, res, next) => {
  const ip = req.ip || "unknown";
  if (!checkRateLimit(ip, 60, 60_000)) {
    log(LogLevel.WARN, { type: "rate_limit_exceeded", ip, path: req.path });
    res.status(429).json({ error: "Too many requests" });
    return;
  }
  next();
});

const sessions = new SessionManager();

// Health check endpoint with dependency checks
app.get("/api/health", async (_req, res) => {
  const start = Date.now();
  
  // Check dependencies
  const checks: Record<string, { status: string; latency?: number; error?: string }> = {};
  
  // Check GitHub API (if token configured)
  const githubToken = getSecret("GITHUB_TOKEN");
  if (githubToken) {
    try {
      const ghStart = Date.now();
      const res = await fetch("https://api.github.com/rate_limit", {
        headers: { Authorization: `token ${githubToken}` },
        signal: AbortSignal.timeout(5000),
      });
      checks.github = {
        status: res.ok ? "ok" : "degraded",
        latency: Date.now() - ghStart,
      };
    } catch (e) {
      checks.github = { status: "unreachable", error: String(e) };
    }
  }
  
  // Check memory usage
  const memUsage = process.memoryUsage();
  const memUsageMB = Math.round(memUsage.heapUsed / 1024 / 1024 * 100) / 100;
  checks.memory = {
    status: memUsageMB < 500 ? "ok" : "warning",
    latency: memUsageMB,
  };
  
  // Check active sessions
  const activeSessions = sessions.count();
  checks.sessions = {
    status: activeSessions < 100 ? "ok" : "warning",
    latency: activeSessions,
  };
  
  const overallStatus = Object.values(checks).every(c => c.status === "ok" || c.status === "ok")
    ? "ok"
    : "degraded";
  
  const latency = Date.now() - start;
  
  res.json({
    status: overallStatus,
    timestamp: new Date().toISOString(),
    uptime: Math.round(process.uptime()),
    checks,
    latency: `${latency}ms`,
  });
});

// Auth status endpoint
app.get("/api/auth/status", withAuth, (_req, res) => {
  logAudit("auth_status_check", { ip: _req.ip });
  res.json({ authenticated: true });
});

// Session start endpoint
app.post("/api/session/start", requireToken, async (req, res) => {
  const { repoUrl, branch = "main" } = req.body || {};
  if (!repoUrl || typeof repoUrl !== "string") {
    res.status(400).json({ error: "Missing repoUrl" });
    return;
  }
  try {
    const session = await sessions.create(repoUrl, branch, res.locals.token);
    logAudit("session_start", { sessionId: session.id, repoUrl, branch, ip: req.ip });
    res.json({ sessionId: session.id });
  } catch (e) {
    log(LogLevel.ERROR, { type: "session_start_error", error: String(e), repoUrl });
    res.status(500).json({ error: String(e) });
  }
});

// GitHub repos endpoint
app.get("/api/github/repos", withAuth, async (req, res) => {
  const tokenData: TokenData = res.locals.token;
  const query = String(req.query.q || "");
  try {
    const repos = await fetchGitHubRepos(tokenData, query);
    logAudit("github_repos_fetch", { query, count: repos.length, ip: req.ip });
    res.json(repos);
  } catch (e) {
    log(LogLevel.ERROR, { type: "github_repos_error", error: String(e) });
    res.status(500).json({ error: String(e) });
  }
});

async function fetchGitHubRepos(token: TokenData, query: string): Promise<Array<{ full_name: string; clone_url: string; default_branch?: string }>> {
  const headers: Record<string, string> = {
    "Accept": "application/vnd.github.v3+json",
    "User-Agent": "CodeJustWrite/1.0",
  };
  
  if (token.githubToken) {
    headers["Authorization"] = `token ${token.githubToken}`;
  }
  
  const url = query
    ? `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}+in:name&sort=stars&order=desc&per_page=30`
    : `https://api.github.com/user/repos?per_page=30&sort=updated`;
  
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
  
  const data = await res.json() as { items?: Array<{ full_name: string; clone_url: string; default_branch?: string }>; full_name?: string };
  
  if (query && data.items) {
    return data.items;
  }
  return Array.isArray(data) ? data : [];
}

// Request logging middleware
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    logRequest(req, res.statusCode, Date.now() - start);
  });
  next();
});

// Serve static files from web app
const webDist = resolve(__dirname, "../../web/dist");
if (existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get("*", (_req, res) => {
    res.sendFile(resolve(webDist, "index.html"));
  });
}

// WebSocket upgrade handling
server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  const sessionId = url.searchParams.get("sessionId");
  const token = url.searchParams.get("token");
  
  if (!sessionId) {
    log(LogLevel.WARN, { type: "ws_upgrade_rejected", reason: "no_session_id" });
    socket.destroy();
    return;
  }
  
  const session = sessions.get(sessionId);
  if (!session) {
    log(LogLevel.WARN, { type: "ws_upgrade_rejected", reason: "session_not_found", sessionId });
    socket.destroy();
    return;
  }
  
  const authHeader = req.headers.authorization;
  let tokenValid = false;
  
  if (authHeader?.startsWith("Bearer ")) {
    const headerToken = authHeader.slice(7);
    tokenValid = headerToken === session.token || headerToken === getSecret("AUTH_TOKEN");
  } else if (token) {
    tokenValid = token === session.token || token === getSecret("AUTH_TOKEN");
  }
  
  if (!tokenValid) {
    log(LogLevel.WARN, { type: "ws_upgrade_rejected", reason: "invalid_token", sessionId });
    socket.destroy();
    return;
  }
  
  const wsKey = `ws:${sessionId}`;
  
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req, session, wsKey);
  });
});

// WebSocket connection handling
wss.on("connection", (ws: WebSocket, _req: IncomingMessage, session: { id: string; send(message: unknown): void }, wsKey: string) => {
  let messageCount = 0;
  let resetTime = Date.now() + 60_000;
  
  logAudit("ws_connect", { sessionId: session.id, ip: _req.socket.remoteAddress });
  
  ws.on("message", (data) => {
    const now = Date.now();
    if (now > resetTime) {
      messageCount = 0;
      resetTime = now + 60_000;
    }
    
    if (messageCount >= 100) {
      ws.send(JSON.stringify({ type: "error", message: "Rate limit exceeded" }));
      log(LogLevel.WARN, { type: "ws_rate_limit", sessionId: session.id });
      return;
    }
    
    if (data instanceof Buffer && data.length > 100 * 1024) {
      ws.send(JSON.stringify({ type: "error", message: "Message too large" }));
      return;
    }
    
    messageCount++;
    
    try {
      const msg = JSON.parse(String(data));
      session.send(msg);
    } catch {
      ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
    }
  });
  
  const originalSend = session.send.bind(session);
  session.send = (message: unknown) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
    return originalSend(message);
  };
  
  ws.on("close", () => {
    logAudit("ws_disconnect", { sessionId: session.id });
    session.send = originalSend;
  });
});

// Graceful shutdown
process.on("SIGTERM", () => {
  log(LogLevel.INFO, { type: "shutdown", signal: "SIGTERM" });
  server.close(() => {
    log(LogLevel.INFO, { type: "shutdown_complete" });
    process.exit(0);
  });
  
  wss.clients.forEach((client) => {
    client.close();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  log(LogLevel.INFO, { type: "server_start", port: PORT });
});