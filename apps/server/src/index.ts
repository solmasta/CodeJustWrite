import express, { Request, Response, NextFunction } from "express";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { Agent } from "@codejustwrite/core";
import { SessionManager } from "./session.js";
import { requireAuth, checkWsToken } from "./auth.js";
import { withGithubToken, redactSecrets } from "./secrets.js";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { totalmem, freemem } from "os";
import fs from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = process.env.PORT || 3001;
const AUTH_TOKEN = process.env.AUTH_TOKEN;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const WORKSPACES_DIR = process.env.WORKSPACES_DIR || "/tmp/cjw-workspaces";
const SESSION_TTL_MINUTES = parseInt(process.env.SESSION_TTL_MINUTES || "60", 10);
const MAX_SESSIONS = parseInt(process.env.MAX_SESSIONS || "50", 10);

const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const MAX_REQUESTS_PER_WINDOW = 60;
const MAX_WS_MESSAGES_PER_MINUTE = 100;
const MAX_WS_MESSAGE_SIZE = 100 * 1024;

const requestCounts = new Map<string, { count: number; resetTime: number }>>();

function getClientIp(req: Request): string {
  return (req.headers["x-forwarded-for"] as string) || req.socket.remoteAddress || "unknown";
}

function checkRateLimit(clientIp: string): boolean {
  const now = Date.now();
  const windowStart = Math.floor(now / RATE_LIMIT_WINDOW_MS) * RATE_LIMIT_WINDOW_MS;
  
  const entry = requestCounts.get(clientIp);
  if (!entry || entry.resetTime < windowStart) {
    requestCounts.set(clientIp, { count: 1, resetTime: windowStart + RATE_LIMIT_WINDOW_MS });
    return true;
  }
  
  if (entry.count >= MAX_REQUESTS_PER_WINDOW) {
    return false;
  }
  
  entry.count++;
  return true;
}

function cleanupRateLimits(): void {
  const now = Date.now();
  for (const [ip, entry] of requestCounts.entries()) {
    if (entry.resetTime < now) {
      requestCounts.delete(ip);
    }
  }
}

setInterval(cleanupRateLimits, 5 * 60 * 1000);

const config = {
  workspacesDir: WORKSPACES_DIR,
  defaultBranch: "main",
  shellTimeoutSec: 30,
  maxOutputLines: 1000,
  providers: [],
  selectedProvider: undefined,
  selectedModel: undefined,
};

const sessions = new SessionManager(WORKSPACES_DIR, config, SESSION_TTL_MINUTES * 60 * 1000, MAX_SESSIONS);

const app = express();
app.use(express.json({ limit: "100kb" }));

app.use((req, res, next) => {
  res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:;");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  next();
});

app.use((req, res, next) => {
  const clientIp = getClientIp(req);
  if (!checkRateLimit(clientIp)) {
    res.status(429).json({ error: "Rate limit exceeded" });
    return;
  }
  next();
});

app.get("/api/health", (_req, res) => {
  const memoryUsage = process.memoryUsage();
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    checks: {
      github: { status: "ok", latency: 0 },
      memory: { status: "ok", latency: memoryUsage.heapUsed / 1024 / 1024 },
      sessions: { status: "ok", latency: sessions.size }
    },
    uptime: process.uptime()
  });
});

app.post("/api/session/start", requireAuth(AUTH_TOKEN), async (req, res) => {
  const { repoUrl, branch } = req.body;
  if (!repoUrl) {
    res.status(400).json({ error: "repoUrl is required" });
    return;
  }

  try {
    const session = await sessions.createSession(repoUrl, branch || "main");
    res.json({ sessionId: session.id, repoUrl, branch: session.branch });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.post("/api/session/stop", requireAuth(AUTH_TOKEN), async (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId) {
    res.status(400).json({ error: "sessionId is required" });
    return;
  }

  try {
    await sessions.disposeSession(sessionId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get("/api/repos", requireAuth(AUTH_TOKEN), async (_req, res) => {
  if (!GITHUB_TOKEN) {
    res.status(503).json({ error: "GitHub token not configured" });
    return;
  }

  try {
    const repos = await withGithubToken(GITHUB_TOKEN, async (token) => {
      const response = await fetch("https://api.github.com/user/repos?sort=updated&per_page=100", {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!response.ok) throw new Error(`GitHub API error: ${response.status}`);
      return await response.json();
    });
    res.json(repos);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws, req) => {
  const url = new URL(req.url || "", `http://localhost`);
  const sessionId = url.searchParams.get("sessionId");
  const token = url.searchParams.get("token");

  if (!sessionId || !token) {
    ws.close(1008, "Missing sessionId or token");
    return;
  }

  if (!checkWsToken(AUTH_TOKEN, token)) {
    ws.close(1008, "Invalid token");
    return;
  }

  const session = sessions.get(sessionId);
  if (!session) {
    ws.close(1008, "Session not found");
    return;
  }

  let messageCount = 0;
  let lastMessageTime = Date.now();

  ws.on("message", async (data) => {
    const now = Date.now();
    if (now - lastMessageTime > 60000) {
      messageCount = 0;
      lastMessageTime = now;
    }

    if (++messageCount > MAX_WS_MESSAGES_PER_MINUTE) {
      ws.close(1008, "Rate limit exceeded");
      return;
    }

    if (data.length > MAX_WS_MESSAGE_SIZE) {
      ws.close(1009, "Message too large");
      return;
    }

    try {
      const message = JSON.parse(data.toString());
      if (message.type === "chat" && message.text) {
        const agent = new Agent(session.id, config);
        const response = await agent.chat(message.text);
        ws.send(JSON.stringify({ type: "assistant", text: response }));
      }
    } catch (err) {
      ws.send(JSON.stringify({ type: "error", error: redactSecrets(String(err)) }));
    }
  });

  ws.on("close", () => {
    console.log(`WebSocket closed for session: ${sessionId}`);
  });

  ws.send(JSON.stringify({ type: "connected", sessionId }));
});

const gracefulShutdown = () => {
  console.log("Shutting down gracefully...");
  wss.clients.forEach((client) => client.close());
  server.close(() => {
    console.log("Server closed");
    process.exit(0);
  });
};

process.on("SIGTERM", gracefulShutdown);
process.on("SIGINT", gracefulShutdown);

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
