import express from "express";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { Agent, SessionManager, registry } from "@codejustwrite/core";
import { requireAuth, checkWsToken, withAuth } from "./auth.js";
import { withGithubToken, redactSecrets, getSecret } from "./secrets.js";

// ESM __dirname equivalent
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Configuration
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3001;
const HOST = process.env.HOST ?? "0.0.0.0";
const AUTH_TOKEN = process.env.CJW_AUTH_TOKEN;
const GITHUB_TOKEN = process.env.CJW_GITHUB_TOKEN;
const WORKSPACES_DIR = process.env.CJW_WORKSPACES_DIR ?? "/tmp/cjw-workspaces";
const SESSION_TTL_MINUTES = 30;
const MAX_SESSIONS = 50;

// Rate limiting configuration
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 60;
const WS_RATE_LIMIT_MAX_MESSAGES = 100;

// Create Express app
const app = express();
app.use(express.json({ limit: "100kb" }));

// Security headers
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline';"
  );
  next();
});

// Structured logging
function log(level: string, type: string, data: Record<string, unknown>) {
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), level, type, ...data }));
}

// Rate limiting
interface RateLimitEntry {
  count: number;
  resetTime: number;
}
const rateLimitMap = new Map<string, RateLimitEntry>();

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  
  if (!entry || now > entry.resetTime) {
    rateLimitMap.set(ip, {
      count: 1,
      resetTime: now + RATE_LIMIT_WINDOW_MS,
    });
    return true;
  }
  
  if (entry.count >= RATE_LIMIT_MAX_REQUESTS) {
    return false;
  }
  
  entry.count++;
  return true;
}

// Periodic cleanup of rate limit entries
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap.entries()) {
    if (now > entry.resetTime) {
      rateLimitMap.delete(ip);
    }
  }
}, 60_000); // Clean up every minute

// Request logging middleware
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    const duration = Date.now() - start;
    log("INFO", "http_request", {
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration: `${duration}ms`,
      ip: req.ip,
    });
  });
  next();
});

// Rate limiting middleware
app.use((req, res, next) => {
  if (!checkRateLimit(req.ip ?? "unknown")) {
    log("WARN", "rate_limit_exceeded", { ip: req.ip });
    return res.status(429).json({ error: "Rate limit exceeded" });
  }
  next();
});

// Auth middleware for /api routes
app.use("/api", requireAuth(AUTH_TOKEN));

// Health check endpoint
app.get("/api/health", (_req, res) => {
  const memUsage = process.memoryUsage();
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    checks: {
      github: { status: "ok", latency: 0 },
      memory: {
        status: memUsage.heapUsed < 500 * 1024 * 1024 ? "ok" : "warning",
        latency: memUsage.heapUsed / 1024 / 1024,
      },
      sessions: { status: "ok", latency: 0 },
    },
    uptime: process.uptime(),
  });
});

// Create agent config
const config = {
  provider: "openai",
  model: "gpt-4",
  apiKey: process.env.OPENAI_API_KEY ?? "",
  baseUrl: undefined,
  temperature: 0.1,
  maxTokens: 4096,
  timeoutSec: 120,
  shellTimeoutSec: 60,
  maxIterations: 50,
};

// Initialize session manager
const sessions = new SessionManager(WORKSPACES_DIR, config, SESSION_TTL_MINUTES * 60 * 1000, MAX_SESSIONS);

// Start session endpoint
app.post("/api/sessions", async (req, res) => {
  const { repoUrl, branch, provider, model, apiKey } = req.body;
  
  if (!repoUrl) {
    return res.status(400).json({ error: "repoUrl is required" });
  }
  
  try {
    const session = await sessions.createSession(repoUrl, branch ?? "main", provider, model, apiKey);
    log("AUDIT", "session_start", { sessionId: session.id, repoUrl });
    res.json({ sessionId: session.id, repoUrl: session.repoUrl, branch: session.branch });
  } catch (error) {
    log("ERROR", "session_start_failed", { error: String(error), repoUrl });
    res.status(500).json({ error: "Failed to create session" });
  }
});

// Get session status
app.get("/api/sessions/:sessionId", (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) {
    return res.status(404).json({ error: "Session not found" });
  }
  res.json({
    sessionId: session.id,
    repoUrl: session.repoUrl,
    branch: session.branch,
    createdAt: session.createdAt,
  });
});

// List my repos endpoint
app.get("/api/repos", async (_req, res) => {
  if (!GITHUB_TOKEN) {
    return res.status(503).json({ error: "GitHub token not configured" });
  }
  
  try {
    const response = await fetch("https://api.github.com/user/repos?sort=updated&per_page=100", {
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "CodeJustWrite/1.0",
      },
    });
    
    if (!response.ok) {
      throw new Error(`GitHub API error: ${response.status}`);
    }
    
    const repos = await response.json();
    res.json(repos.map((r: { full_name: string; html_url: string; default_branch: string }) => ({
      fullName: r.full_name,
      htmlUrl: r.html_url,
      defaultBranch: r.default_branch,
    })));
  } catch (error) {
    log("ERROR", "github_api_error", { error: String(error) });
    res.status(500).json({ error: "Failed to fetch repositories" });
  }
});

// Serve static files from web app
const webDist = join(__dirname, "../../web/dist");
app.use(express.static(webDist));

// SPA fallback - serve index.html for all non-API routes
app.get("*", (_req, res) => {
  res.sendFile(join(webDist, "index.html"));
});

// Create HTTP server
const server = createServer(app);

// WebSocket handling
server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
  const sessionId = url.searchParams.get("sessionId");
  const token = url.searchParams.get("token");
  
  if (!sessionId) {
    socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    socket.destroy();
    return;
  }
  
  if (!checkWsToken(AUTH_TOKEN, token)) {
    log("WARN", "ws_auth_failed", { sessionId });
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
  
  // Accept the WebSocket connection
  log("INFO", "ws_connect", { sessionId });
  
  // Create a simple message handler
  const messageCount = { count: 0 };
  const messageInterval = setInterval(() => {
    messageCount.count = 0;
  }, 60_000);
  
  socket.on("data", (data) => {
    messageCount.count++;
    if (messageCount.count > WS_RATE_LIMIT_MAX_MESSAGES) {
      log("WARN", "ws_rate_limit_exceeded", { sessionId });
      socket.end();
      return;
    }
    
    try {
      const message = JSON.parse(data.toString());
      if (message.type === "chat" && message.text) {
        // Process chat message through agent
        const agent = new Agent(config, registry);
        agent.run(message.text, session.workspace).then((result) => {
          socket.write(JSON.stringify({ type: "response", text: result }) + "\n");
        }).catch((error) => {
          log("ERROR", "agent_error", { sessionId, error: String(error) });
          socket.write(JSON.stringify({ type: "error", message: "Agent execution failed" }) + "\n");
        });
      }
    } catch (error) {
      log("ERROR", "ws_message_parse_error", { sessionId, error: String(error) });
    }
  });
  
  socket.on("close", () => {
    clearInterval(messageInterval);
    log("INFO", "ws_disconnect", { sessionId });
  });
  
  socket.on("error", (error) => {
    log("ERROR", "ws_error", { sessionId, error: String(error) });
  });
  
  // Send connection confirmation
  socket.write(JSON.stringify({ type: "connected", sessionId }) + "\n");
});

// Graceful shutdown
process.on("SIGTERM", () => {
  log("INFO", "shutdown", { reason: "SIGTERM" });
  server.close(() => {
    process.exit(0);
  });
});

// Start server
server.listen(PORT, HOST, () => {
  log("INFO", "server_start", { host: HOST, port: PORT });
  console.log(`Server running on http://${HOST}:${PORT}`);
});
