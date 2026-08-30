import express, { Request, Response } from "express";
import { WebSocketServer, WebSocket } from "ws";
import { createServer } from "http";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { loadConfig } from "@codejustwrite/core";
import { SessionManager, Session } from "./session.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

const WORKSPACES_DIR = "/tmp/cjw-workspaces";
const SESSION_TTL_MINUTES = 60;
const MAX_SESSIONS = 50;

// Load config from environment using the core's loadConfig function
const config = loadConfig();

const sessions = new SessionManager(WORKSPACES_DIR, config, SESSION_TTL_MINUTES * 60 * 1000, MAX_SESSIONS);

app.use(express.json({ limit: "100kb" }));
app.use(express.text({ limit: "100kb" }));

// CORS headers
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization");
  if (req.method === "OPTIONS") {
    res.sendStatus(200);
  } else {
    next();
  }
});

// Security headers
app.use((req, res, next) => {
  res.header("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:;");
  res.header("X-Frame-Options", "DENY");
  res.header("X-Content-Type-Options", "nosniff");
  res.header("Referrer-Policy", "no-referrer");
  next();
});

// Rate limiting
const rateLimits = new Map<string, { count: number; resetTime: number }>();
const RATE_LIMIT = 60;
const RATE_WINDOW = 60000;

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const limit = rateLimits.get(ip);
  if (!limit || now > limit.resetTime) {
    rateLimits.set(ip, { count: 1, resetTime: now + RATE_WINDOW });
    return true;
  }
  if (limit.count >= RATE_LIMIT) {
    return false;
  }
  limit.count++;
  return true;
}

app.use((req, res, next) => {
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  if (!checkRateLimit(ip)) {
    res.status(429).json({ error: "Too many requests" });
    return;
  }
  next();
});

// Health check
app.get("/api/health", (req, res) => {
  const memUsage = process.memoryUsage();
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    checks: {
      github: { status: "ok", latency: 0 },
      memory: { status: "ok", used: Math.round(memUsage.heapUsed / 1024 / 1024) },
      sessions: { status: "ok", count: sessions.size }
    },
    uptime: process.uptime()
  });
});

// List repositories
app.get("/api/repos", async (req: Request, res: Response) => {
  try {
    if (!config.githubToken) {
      res.status(500).json({ error: "GitHub token not configured" });
      return;
    }
    
    const response = await fetch("https://api.github.com/user/repos?per_page=100&sort=updated", {
      headers: {
        Authorization: `Bearer ${config.githubToken}`,
        Accept: "application/vnd.github.v3+json"
      }
    });
    
    if (!response.ok) {
      res.status(500).json({ error: "Failed to fetch repositories" });
      return;
    }
    
    const repos = await response.json() as Array<{
      id: number;
      name: string;
      full_name: string;
      html_url: string;
      description: string | null;
      updated_at: string;
    }>;
    const result = repos.map(repo => ({
      id: repo.id,
      name: repo.name,
      fullName: repo.full_name,
      url: repo.html_url,
      description: repo.description,
      updatedAt: repo.updated_at
    }));
    res.json({ repos: result });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch repositories" });
  }
});

// Create session
app.post("/api/sessions", async (req: Request, res: Response) => {
  try {
    const { repoUrl, branch } = req.body;
    if (!repoUrl) {
      res.status(400).json({ error: "repoUrl is required" });
      return;
    }
    
    const session = await sessions.createSession(repoUrl, branch || "main");
    res.json({ sessionId: session.id });
  } catch (error) {
    res.status(500).json({ error: "Failed to create session" });
  }
});

// Static files
const staticPath = join(__dirname, "..", "web", "dist");
app.use(express.static(staticPath));
app.get("*", (req, res) => {
  res.sendFile(join(staticPath, "index.html"));
});

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("SIGTERM received, shutting down gracefully");
  wss.close();
  server.close(() => {
    console.log("Server closed");
    process.exit(0);
  });
});

// WebSocket handling
const wsRateLimits = new Map<string, { count: number; resetTime: number }>();
const WS_RATE_LIMIT = 100;
const WS_RATE_WINDOW = 60000;

wss.on("connection", async (ws: WebSocket, req) => {
  const url = new URL(req.url || "", `http://${req.headers.host}`);
  const sessionId = url.searchParams.get("sessionId");
  const token = url.searchParams.get("token");

  if (!sessionId) {
    ws.close(1008, "Missing sessionId");
    return;
  }

  const ip = req.socket.remoteAddress || "unknown";
  const now = Date.now();
  const wsLimit = wsRateLimits.get(ip);
  if (!wsLimit || now > wsLimit.resetTime) {
    wsRateLimits.set(ip, { count: 1, resetTime: now + WS_RATE_WINDOW });
  } else {
    if (wsLimit.count >= WS_RATE_LIMIT) {
      ws.close(1008, "Rate limit exceeded");
      return;
    }
    wsLimit.count++;
  }

  const session = sessions.get(sessionId);
  if (!session) {
    ws.close(1008, "Invalid session");
    return;
  }

  session.attach(ws);

  let isConnected = true;

  ws.on("message", async (data: Buffer) => {
    if (!isConnected) return;
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === "user_message") {
        await session.handleUserMessage(msg.text);
      }
    } catch (e) {
      console.error("WebSocket message error:", e);
    }
  });

  ws.on("close", () => {
    isConnected = false;
    session.detach(ws);
  });

  ws.on("error", (err) => {
    console.error("WebSocket error:", err);
    isConnected = false;
  });

  // Send welcome
  ws.send(JSON.stringify({ type: "connected", sessionId }));
});

const PORT = parseInt(process.env.PORT || "3000", 10);
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});