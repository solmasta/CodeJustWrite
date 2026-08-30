import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { parse as parseUrl } from "url";
import { Agent } from "@codejustwrite/core";
import { SessionManager } from "@codejustwrite/core";
import { withGithubToken, redactSecrets } from "./secrets.js";
import { requireAuth, checkWsToken, AUTH_TOKEN } from "./auth.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// Configuration
const PORT = parseInt(process.env.PORT || "3000", 10);
const WORKSPACES_DIR = process.env.WORKSPACES_DIR || "/tmp/cjw-workspaces";
const SESSION_TTL_MINUTES = parseInt(process.env.SESSION_TTL_MINUTES || "60", 10);
const MAX_SESSIONS = parseInt(process.env.MAX_SESSIONS || "50", 10);
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
const LOG_REQUESTS = process.env.LOG_REQUESTS !== "false";
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 60;
const WS_RATE_LIMIT_MESSAGES = 100;
const MAX_MESSAGE_SIZE = 100 * 1024;

const config = {
  provider: (process.env.LLM_PROVIDER || "openai") as "openai" | "deepinfra" | "openrouter",
  model: process.env.LLM_MODEL || "gpt-4o-mini",
  apiKey: process.env.LLM_API_KEY || "",
  deepinfraModel: process.env.DEEPINFRA_MODEL || "meta-llama/Llama-3.3-70B-Instruct",
  openrouterModel: process.env.OPENROUTER_MODEL || "openai/gpt-4o-mini",
  shellTimeoutSec: parseInt(process.env.SHELL_TIMEOUT_SEC || "30", 10),
  maxOutputChars: parseInt(process.env.MAX_OUTPUT_CHARS || "50000", 10),
  sandboxTimeoutSec: parseInt(process.env.SANDBOX_TIMEOUT_SEC || "300", 10),
};

// Rate limiting state
const rateLimitMap = new Map<string, { count: number; resetTime: number }>();
const wsRateLimitMap = new Map<string, { count: number; resetTime: number }>();

// Session manager
const sessions = new SessionManager(WORKSPACES_DIR, config, SESSION_TTL_MINUTES * 60 * 1000, MAX_SESSIONS);

// Periodic cleanup of rate limit entries
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of rateLimitMap.entries()) {
    if (value.resetTime < now) rateLimitMap.delete(key);
  }
  for (const [key, value] of wsRateLimitMap.entries()) {
    if (value.resetTime < now) wsRateLimitMap.delete(key);
  }
}, 5 * 60 * 1000);

function log(level: string, type: string, meta: Record<string, unknown> = {}) {
  console.log(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      type,
      ...meta,
    })
  );
}

function logRequest(
  method: string,
  path: string,
  status: number,
  duration: number
) {
  if (!LOG_REQUESTS) return;
  log("INFO", "http_request", { method, path, status, duration });
}

function logAudit(action: string, meta: Record<string, unknown> = {}) {
  log("AUDIT", action, meta);
}

// Ensure directories exist
fs.mkdirSync(WORKSPACES_DIR, { recursive: true });

const server = createServer((req, res) => {
  const start = Date.now();
  const url = req.url || "/";
  const clientIp =
    (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
    req.socket.remoteAddress ||
    "unknown";

  // Rate limiting
  const now = Date.now();
  const rateLimit = rateLimitMap.get(clientIp) || {
    count: 0,
    resetTime: now + RATE_LIMIT_WINDOW_MS,
  };
  rateLimit.count++;
  rateLimitMap.set(clientIp, rateLimit);

  if (rateLimit.count > RATE_LIMIT_MAX_REQUESTS) {
    res.writeHead(429, {
      "Content-Type": "application/json",
      "X-RateLimit-Reset": Math.ceil(rateLimit.resetTime / 1000).toString(),
    });
    res.end(JSON.stringify({ error: "Too many requests" }));
    return;
  }

  if (rateLimit.resetTime < now) {
    rateLimit.count = 1;
    rateLimit.resetTime = now + RATE_LIMIT_WINDOW_MS;
  }

  // Parse URL and path
  const parsedUrl = parseUrl(url, true);
  const pathname = parsedUrl.pathname;

  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-GitHub-Token"
  );
  res.setHeader("Access-Control-Max-Age", "86400");

  // Security headers
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; img-src 'self' data:;"
  );

  // Handle OPTIONS
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    logRequest(req.method || "OPTIONS", pathname, 204, Date.now() - start);
    return;
  }

  // Auth check for API routes
  if (pathname.startsWith("/api/") && pathname !== "/api/health") {
    const authError = requireAuth(req, res);
    if (authError) {
      logRequest(req.method || "GET", pathname, 401, Date.now() - start);
      return;
    }
  }

  // Route: Health check
  if (pathname === "/api/health") {
    const memUsage = process.memoryUsage();
    const memUsageMB = Math.round(memUsage.heapUsed / 1024 / 1024 * 100) / 100;
    
    // Simple health check
    const health = {
      status: "ok",
      timestamp: new Date().toISOString(),
      checks: {
        memory: { 
          status: memUsageMB < 512 ? "ok" : "warning",
          value: `${memUsageMB} MB`
        },
        sessions: {
          status: "ok",
          count: sessions.size
        }
      },
      uptime: Math.round(process.uptime())
    };

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(health));
    logRequest(req.method || "GET", pathname, 200, Date.now() - start);
    return;
  }

  // Route: Metrics
  if (pathname === "/api/metrics") {
    const memUsage = process.memoryUsage();
    const metrics = {
      uptime_seconds: Math.round(process.uptime()),
      memory_heap_used_bytes: memUsage.heapUsed,
      memory_heap_total_bytes: memUsage.heapTotal,
      memory_rss_bytes: memUsage.rss,
      active_sessions: sessions.size,
      rate_limit_entries: rateLimitMap.size,
    };

    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(
      Object.entries(metrics)
        .map(([k, v]) => `${k} ${v}`)
        .join("\n")
    );
    logRequest(req.method || "GET", pathname, 200, Date.now() - start);
    return;
  }

  // Route: Monitoring dashboard
  if (pathname === "/api/monitoring") {
    const memUsage = process.memoryUsage();
    const html = `<!DOCTYPE html>
<html>
<head>
  <title>CodeJustWrite Monitoring</title>
  <meta http-equiv="refresh" content="5">
  <style>
    body { font-family: system-ui; background: #1a1a2e; color: #eee; padding: 20px; }
    h1 { color: #00d4ff; }
    .metric { display: inline-block; background: #16213e; padding: 15px; margin: 10px; border-radius: 8px; }
    .metric-value { font-size: 24px; font-weight: bold; color: #00d4ff; }
    .metric-label { font-size: 12px; color: #888; }
    .section { margin: 20px 0; }
    .sessions { background: #16213e; padding: 10px; border-radius: 4px; font-family: monospace; }
  </style>
</head>
<body>
  <h1>CodeJustWrite Monitoring</h1>
  <div class="section">
    <h2>System Metrics</h2>
    <div class="metric">
      <div class="metric-value">${Math.round(memUsage.heapUsed / 1024 / 1024)} MB</div>
      <div class="metric-label">Heap Used</div>
    </div>
    <div class="metric">
      <div class="metric-value">${sessions.size}</div>
      <div class="metric-label">Active Sessions</div>
    </div>
    <div class="metric">
      <div class="metric-value">${Math.round(process.uptime())}s</div>
      <div class="metric-label">Uptime</div>
    </div>
  </div>
  <div class="section">
    <h2>Active Sessions</h2>
    <pre class="sessions">${JSON.stringify(sessions.list(), null, 2)}</pre>
  </div>
</body>
</html>`;

    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(html);
    logRequest(req.method || "GET", pathname, 200, Date.now() - start);
    return;
  }

  // Route: Session creation
  if (pathname === "/api/sessions" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > MAX_MESSAGE_SIZE) {
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Request body too large" }));
        return;
      }
    });
    req.on("end", async () => {
      try {
        const data = JSON.parse(body);
        const { repoUrl, branch, githubToken } = data;

        if (!repoUrl) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "repoUrl is required" }));
          return;
        }

        const token = githubToken || GITHUB_TOKEN;
        if (token) {
          await withGithubToken(token);
        }

        const sessionId = await sessions.createSession(repoUrl, branch || "main", githubToken || GITHUB_TOKEN);

        logAudit("session_start", { sessionId, repoUrl, branch });

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ sessionId }));
      } catch (err) {
        const error = err instanceof Error ? err.message : "Unknown error";
        log("ERROR", "session_create", { error });
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error }));
      }
    });
    return;
  }

  // Route: Session info
  if (pathname.startsWith("/api/sessions/") && req.method === "GET") {
    const sessionId = pathname.split("/")[3];
    const session = sessions.getSession(sessionId);

    if (!session) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Session not found" }));
      return;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ sessionId, repoUrl: session.repoUrl, branch: session.branch }));
    logRequest(req.method || "GET", pathname, 200, Date.now() - start);
    return;
  }

  // Route: Session deletion
  if (pathname.startsWith("/api/sessions/") && req.method === "DELETE") {
    const sessionId = pathname.split("/")[3];
    sessions.deleteSession(sessionId);

    logAudit("session_delete", { sessionId });

    res.writeHead(204);
    res.end();
    return;
  }

  // Route: GitHub repos (protected)
  if (pathname === "/api/github/repos" && req.method === "GET") {
    const authError = requireAuth(req, res);
    if (authError) return;

    const repos = await withGithubToken(GITHUB_TOKEN).then(() =>
      fetch("https://api.github.com/user/repos?sort=updated&per_page=100", {
        headers: {
          Authorization: `Bearer ${GITHUB_TOKEN}`,
          Accept: "application/vnd.github.v3+json",
        },
      }).then((r) => r.json())
    );

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(repos));
    logRequest(req.method || "GET", pathname, 200, Date.now() - start);
    return;
  }

  // Route: Auth status
  if (pathname === "/api/auth/status" && req.method === "GET") {
    const authError = requireAuth(req, res);
    if (authError) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ authenticated: false }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ authenticated: true }));
    return;
  }

  // Static files
  const staticPath = path.join(process.cwd(), "dist", pathname);
  if (fs.existsSync(staticPath) && fs.statSync(staticPath).isFile()) {
    const ext = path.extname(staticPath);
    const contentTypes: Record<string, string> = {
      ".html": "text/html",
      ".js": "application/javascript",
      ".css": "text/css",
      ".json": "application/json",
      ".png": "image/png",
      ".svg": "image/svg+xml",
    };
    res.writeHead(200, {
      "Content-Type": contentTypes[ext] || "application/octet-stream",
    });
    fs.createReadStream(staticPath).pipe(res);
    logRequest(req.method || "GET", pathname, 200, Date.now() - start);
    return;
  }

  // Default: Serve index.html
  const indexPath = path.join(process.cwd(), "dist", "index.html");
  if (fs.existsSync(indexPath)) {
    res.writeHead(200, { "Content-Type": "text/html" });
    fs.createReadStream(indexPath).pipe(res);
  } else {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<!DOCTYPE html><html><body><h1>CodeJustWrite Server</h1><p>Build the web app to serve the UI.</p></body></html>");
  }
  logRequest(req.method || "GET", pathname, 200, Date.now() - start);
});

// WebSocket server
const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (socket: WebSocket, sessionId: string) => {
  logAudit("ws_connect", { sessionId });

  socket.on("message", async (data) => {
    const now = Date.now();
    const rateLimit = wsRateLimitMap.get(sessionId) || {
      count: 0,
      resetTime: now + RATE_LIMIT_WINDOW_MS,
    };
    rateLimit.count++;
    wsRateLimitMap.set(sessionId, rateLimit);

    if (rateLimit.count > WS_RATE_LIMIT_MESSAGES) {
      socket.send(JSON.stringify({ error: "Rate limit exceeded" }));
      return;
    }

    if (rateLimit.resetTime < now) {
      rateLimit.count = 1;
      rateLimit.resetTime = now + RATE_LIMIT_WINDOW_MS;
    }

    try {
      const message = JSON.parse(data.toString());
      const session = sessions.getSession(sessionId);

      if (!session) {
        socket.send(JSON.stringify({ error: "Session not found" }));
        return;
      }

      if (message.type === "chat") {
        const agent = new Agent({
          ...config,
          workspace: session.workspace,
        });

        const stream = agent.chatStream(message.content, {
          signal: AbortSignal.timeout(config.sandboxTimeoutSec * 1000),
        });

        for await (const event of stream) {
          socket.send(JSON.stringify(event));
        }

        socket.send(JSON.stringify({ done: true }));
      } else if (message.type === "ping") {
        socket.send(JSON.stringify({ type: "pong" }));
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : "Unknown error";
      log("ERROR", "ws_message", { sessionId, error });
      socket.send(JSON.stringify({ error }));
    }
  });

  socket.on("close", () => {
    logAudit("ws_disconnect", { sessionId });
  });

  socket.on("error", (err) => {
    log("ERROR", "ws_error", { sessionId, error: err.message });
  });
});

server.on("upgrade", (req, socket, head) => {
  const url = req.url || "/";
  const parsedUrl = parseUrl(url, true);
  const pathname = parsedUrl.pathname;

  if (pathname !== "/ws") {
    socket.destroy();
    return;
  }

  const sessionId = parsedUrl.query.sessionId as string;
  const token = parsedUrl.query.token as string;

  if (!sessionId) {
    socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    socket.destroy();
    return;
  }

  // Validate token
  const session = sessions.getSession(sessionId);
  if (!session) {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }

  // Check token
  const tokenError = checkWsToken(AUTH_TOKEN, token);
  if (tokenError) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, sessionId);
  });
});

// Graceful shutdown
process.on("SIGTERM", () => {
  log("INFO", "shutdown", { reason: "SIGTERM" });
  wss.clients.forEach((client) => client.close());
  server.close(() => process.exit(0));
});

server.listen(PORT, () => {
  log("INFO", "start", { port: PORT });
  console.log(`Server running on port ${PORT}`);
});