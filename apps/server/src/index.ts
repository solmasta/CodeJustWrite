import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { withGithubToken, redactSecrets } from "./secrets.js";
import { requireAuth, checkWsToken, AUTH_TOKEN } from "./auth.js";
import { SessionManager, type AgentConfig as CjwConfig } from "@codejustwrite/core";

// Constants
const PORT = parseInt(process.env.PORT || "3000", 10);
const WORKSPACES_DIR = process.env.WORKSPACES_DIR || "/tmp/cjw-workspaces";
const SESSION_TTL_MINUTES = parseInt(process.env.SESSION_TTL_MINUTES || "60", 10);
const MAX_SESSIONS = parseInt(process.env.MAX_SESSIONS || "50", 10);

// Config
const config: CjwConfig = {
  provider: (process.env.LLM_PROVIDER || "openai") as "openai" | "deepinfra" | "openrouter",
  model: process.env.LLM_MODEL || "gpt-4o-mini",
  apiKey: process.env.LLM_API_KEY || "",
  baseUrl: process.env.LLM_BASE_URL,
  maxTokens: parseInt(process.env.LLM_MAX_TOKENS || "4096", 10),
  temperature: parseFloat(process.env.LLM_TEMPERATURE || "0.7"),
  shellTimeoutSec: parseInt(process.env.SHELL_TIMEOUT_SEC || "120", 10),
};

// Session manager
const sessions = new SessionManager(WORKSPACES_DIR, config, SESSION_TTL_MINUTES * 60 * 1000, MAX_SESSIONS);

// Rate limiting
const rateLimitMap = new Map<string, { count: number; resetTime: number }>();
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 60;

// Health check
async function checkHealth() {
  const result = { status: "ok", timestamp: new Date().toISOString(), checks: {} as Record<string, { status: string; latency?: number }> };
  
  // Check GitHub API connectivity
  try {
    const start = Date.now();
    const ghResponse = await fetch("https://api.github.com/rate_limit", {
      headers: withGithubToken({ "User-Agent": "CodeJustWrite/1.0" })
    });
    result.checks.github = { status: ghResponse.ok ? "ok" : "error", latency: Date.now() - start };
  } catch {
    result.checks.github = { status: "error" };
  }
  
  // Memory usage
  const memUsage = process.memoryUsage();
  result.checks.memory = { status: memUsage.heapUsed < memUsage.heapTotal ? "ok" : "warning", latency: memUsage.heapUsed };
  
  // Active sessions
  result.checks.sessions = { status: "ok", latency: sessions.size };
  
  return result;
}

// Logging functions
function log(level: string, type: string, data: Record<string, unknown> = {}) {
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    type,
    ...data
  }));
}

function logRequest(req: http.IncomingMessage, res: http.ServerResponse, duration: number) {
  log("INFO", "http_request", {
    method: req.method,
    path: req.url,
    status: res.statusCode,
    duration
  });
}

function logAudit(action: string, data: Record<string, unknown> = {}) {
  log("AUDIT", "audit", { action, ...data });
}

// Create HTTP server
const server = http.createServer(async (req, res) => {
  const start = Date.now();
  const reqId = Math.random().toString(36).substring(2, 15);
  
  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  
  // Security headers
  res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; img-src 'self' data:;");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  
  // Handle preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  
  // Rate limiting
  const clientIp = req.headers["x-forwarded-for"]?.toString().split(",")[0] || req.socket.remoteAddress || "unknown";
  const now = Date.now();
  let rlInfo = rateLimitMap.get(clientIp);
  
  if (!rlInfo || now > rlInfo.resetTime) {
    rlInfo = { count: 0, resetTime: now + RATE_LIMIT_WINDOW_MS };
    rateLimitMap.set(clientIp, rlInfo);
  }
  
  rlInfo.count++;
  
  if (rlInfo.count > RATE_LIMIT_MAX) {
    res.writeHead(429, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Too many requests" }));
    log("WARN", "rate_limit", { clientIp, count: rlInfo.count });
    return;
  }
  
  // Parse URL
  const parsedUrl = url.parse(req.url || "/", true);
  const pathname = parsedUrl.pathname || "/";
  
  // Health check
  if (pathname === "/api/health") {
    const health = await checkHealth();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(health));
    logRequest(req, res, Date.now() - start);
    return;
  }
  
  // Auth-protected endpoints
  if (pathname.startsWith("/api/")) {
    const authResult = requireAuth(req);
    if (!authResult.success) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: authResult.error }));
      logAudit("auth_failed", { path: pathname, reason: authResult.error });
      return;
    }
  }
  
  // API endpoints
  if (pathname === "/api/repos") {
    const repos = await fetch("https://api.github.com/user/repos?per_page=100&sort=updated", {
      headers: withGithubToken({ "User-Agent": "CodeJustWrite/1.0" })
    }).then(r => r.json());
    
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(repos.map((r: { full_name: string; html_url: string; description: string | null }) => ({
      name: r.full_name,
      url: r.html_url,
      description: r.description
    }))));
    logAudit("repos_fetched", { count: repos.length });
    logRequest(req, res, Date.now() - start);
    return;
  }
  
  // Serve static files
  const staticPath = path.join(process.cwd(), "dist", pathname);
  if (fs.existsSync(staticPath) && fs.statSync(staticPath).isFile()) {
    const ext = path.extname(staticPath);
    const contentType = ext === ".js" ? "application/javascript" : ext === ".css" ? "text/css" : ext === ".html" ? "text/html" : "text/plain";
    res.writeHead(200, { "Content-Type": contentType });
    res.end(fs.readFileSync(staticPath));
    return;
  }
  
  // Serve index.html for SPA
  const indexPath = path.join(process.cwd(), "dist", "index.html");
  if (fs.existsSync(indexPath)) {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(fs.readFileSync(indexPath));
  } else {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CodeJustWrite</title>
  <style>
    body { font-family: system-ui; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #1a1a2e; color: #eee; }
    .container { text-align: center; padding: 2rem; background: #16213e; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.3); }
    h1 { color: #00d4ff; margin-bottom: 0.5rem; }
    p { color: #aaa; }
  </style>
</head>
<body>
  <div class="container">
    <h1>CodeJustWrite</h1>
    <p>AI-powered code generation</p>
  </div>
</body>
</html>`);
  }
  
  logRequest(req, res, Date.now() - start);
});

// WebSocket server
const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (ws: WebSocket, sessionId: string) => {
  logAudit("ws_connect", { sessionId });
  
  ws.on("close", () => {
    logAudit("ws_disconnect", { sessionId });
    sessions.closeSession(sessionId);
  });
  
  ws.on("error", (err) => {
    log("ERROR", "ws_error", { sessionId, error: err.message });
  });
  
  sessions.handleSession(sessionId, ws);
});

server.on("upgrade", (req, socket, head) => {
  const parsedUrl = url.parse(req.url || "", true);
  const pathname = parsedUrl.pathname || "/";
  
  if (pathname === "/ws") {
    const sessionId = parsedUrl.query.sessionId as string;
    const token = parsedUrl.query.token as string;
    
    if (!sessionId || !checkWsToken(token, AUTH_TOKEN)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      logAudit("ws_rejected", { reason: "Invalid token or sessionId" });
      return;
    }
    
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, sessionId);
    });
  } else {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
  }
});

// Cleanup rate limit map periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of rateLimitMap.entries()) {
    if (now > value.resetTime) {
      rateLimitMap.delete(key);
    }
  }
}, 5 * 60 * 1000);

// Graceful shutdown
process.on("SIGTERM", () => {
  log("INFO", "shutdown", { reason: "SIGTERM" });
  wss.close();
  sessions.cleanup();
  server.close(() => {
    process.exit(0);
  });
});

server.listen(PORT, () => {
  log("INFO", "startup", { port: PORT, workspacesDir: WORKSPACES_DIR });
});