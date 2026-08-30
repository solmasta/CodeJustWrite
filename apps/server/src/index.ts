import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import { SessionManager } from "./session.js";
import { requireAuth, checkWsToken } from "./auth.js";
import { withGithubToken, redactSecrets } from "./secrets.js";
import { createServer } from "http";
import { resolve, dirname } from "path";
import { existsSync } from "fs";
import { fileURLToPath } from "url";
import { totalmem, freemem } from "os";
import type { IncomingMessage } from "http";
import type { Duplex } from "stream";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });

app.use(express.json({ limit: "100kb" }));

// Get auth token from environment
const AUTH_TOKEN = process.env.CJW_AUTH_TOKEN;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

// Structured logging
function log(level: string, type: string, data: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    type,
    ...data
  }));
}

function logRequest(method: string, path: string, status: number, duration: number): void {
  log("INFO", "http_request", { method, path, status, duration });
}

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
    log("INFO", "rate_limit_cleanup", { cleaned });
  }
}, 5 * 60 * 1000);

// HTTP rate limiting (60 requests per minute per IP)
app.use((req, res, next) => {
  const start = Date.now();
  const ip = req.ip || "unknown";
  if (!checkRateLimit(ip, 60, 60_000)) {
    log("WARN", "rate_limit_exceeded", { ip, path: req.path });
    res.status(429).json({ error: "Too many requests" });
    return;
  }
  res.on("finish", () => {
    logRequest(req.method, req.path, res.statusCode, Date.now() - start);
  });
  next();
});

const sessions = new SessionManager();

// Enhanced health check endpoint
app.get("/api/health", async (_req, res) => {
  const checks: Record<string, { status: string; latency?: number; error?: string }> = {};
  const startMemory = totalmem() - freemem();
  
  // Check GitHub API
  try {
    const ghStart = Date.now();
    if (GITHUB_TOKEN) {
      const response = await fetch("https://api.github.com/rate_limit", {
        headers: { Authorization: `token ${GITHUB_TOKEN}`, "User-Agent": "CodeJustWrite/1.0" }
      });
      checks.github = { status: response.ok ? "ok" : "error", latency: Date.now() - ghStart };
    } else {
      checks.github = { status: "not_configured" };
    }
  } catch (e) {
    checks.github = { status: "error", error: String(e) };
  }
  
  // Memory check
  const memUsed = startMemory;
  const memTotal = totalmem();
  const memPercent = (memUsed / memTotal) * 100;
  checks.memory = {
    status: memPercent > 90 ? "critical" : memPercent > 75 ? "warning" : "ok",
    latency: Math.round(memUsed / 1024 / 1024)
  };
  
  // Active sessions
  checks.sessions = { status: "ok", latency: sessions.size };
  
  const allOk = Object.values(checks).every(c => c.status === "ok" || c.status === "not_configured");
  
  res.json({
    status: allOk ? "ok" : "degraded",
    timestamp: new Date().toISOString(),
    checks,
    uptime: process.uptime()
  });
});

// Auth status endpoint
app.get("/api/auth/status", requireAuth(AUTH_TOKEN), (_req, res) => {
  res.json({ authenticated: true });
});

// Session start endpoint
app.post("/api/session/start", requireAuth(AUTH_TOKEN), async (req, res) => {
  const { repoUrl, branch = "main" } = req.body || {};
  if (!repoUrl || typeof repoUrl !== "string") {
    res.status(400).json({ error: "Missing repoUrl" });
    return;
  }
  try {
    const session = await sessions.createSession(repoUrl, branch);
    log("AUDIT", "session_start", { sessionId: session.id, repoUrl, branch });
    res.json({ sessionId: session.id });
  } catch (e) {
    log("ERROR", "session_start_error", { error: String(e) });
    res.status(500).json({ error: String(e) });
  }
});

// GitHub repos endpoint
app.get("/api/github/repos", requireAuth(AUTH_TOKEN), async (req, res) => {
  const query = String(req.query.q || "");
  try {
    const repos = await fetchGitHubRepos(query);
    res.json(repos);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

async function fetchGitHubRepos(query: string): Promise<Array<{ full_name: string; clone_url: string; default_branch?: string }>> {
  const headers: Record<string, string> = {
    "Accept": "application/vnd.github.v3+json",
    "User-Agent": "CodeJustWrite/1.0",
  };
  
  if (GITHUB_TOKEN) {
    headers["Authorization"] = `token ${GITHUB_TOKEN}`;
  }
  
  const url = query
    ? `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}+in:name&sort=stars&order=desc&per_page=30`
    : `https://api.github.com/user/repos?per_page=30&sort=updated`;
  
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`GitHub API error: ${response.status}`);
  
  const data = await response.json() as { items?: Array<{ full_name: string; clone_url: string; default_branch?: string }> };
  
  if (query && data.items) {
    return data.items;
  }
  return Array.isArray(data) ? data : [];
}

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
    socket.destroy();
    return;
  }
  
  const session = sessions.get(sessionId);
  if (!session) {
    socket.destroy();
    return;
  }
  
  // Validate token
  if (!checkWsToken(AUTH_TOKEN, token)) {
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
  log("AUDIT", "ws_connect", { sessionId: session.id });
  
  let messageCount = 0;
  let resetTime = Date.now() + 60_000;
  
  ws.on("message", (data) => {
    const now = Date.now();
    if (now > resetTime) {
      messageCount = 0;
      resetTime = now + 60_000;
    }
    
    if (messageCount >= 100) {
      ws.send(JSON.stringify({ type: "error", message: "Rate limit exceeded" }));
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
    log("AUDIT", "ws_disconnect", { sessionId: session.id });
    session.send = originalSend;
  });
});

// Graceful shutdown
process.on("SIGTERM", () => {
  log("INFO", "shutdown", { reason: "SIGTERM" });
  server.close(() => {
    log("INFO", "server_closed", {});
    process.exit(0);
  });
  
  wss.clients.forEach((client) => {
    client.close();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  log("INFO", "server_start", { port: PORT });
});
