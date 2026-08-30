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
    console.log(`Rate limit cleanup: removed ${cleaned} expired entries`);
  }
}, 5 * 60 * 1000);

// HTTP rate limiting (60 requests per minute per IP)
app.use((req, res, next) => {
  const ip = req.ip || "unknown";
  if (!checkRateLimit(ip, 60, 60_000)) {
    res.status(429).json({ error: "Too many requests" });
    return;
  }
  next();
});

const sessions = new SessionManager();

// Health check endpoint (no auth required)
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Auth status endpoint
app.get("/api/auth/status", withAuth, (_req, res) => {
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
    res.json({ sessionId: session.id });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// GitHub repos endpoint
app.get("/api/github/repos", withAuth, async (req, res) => {
  const tokenData: TokenData = res.locals.token;
  const query = String(req.query.q || "");
  try {
    // Use GitHub CLI if available, otherwise REST API
    const repos = await fetchGitHubRepos(tokenData, query);
    res.json(repos);
  } catch (e) {
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
  // Parse URL and query params
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  const sessionId = url.searchParams.get("sessionId");
  const token = url.searchParams.get("token");
  
  // Validate session
  if (!sessionId) {
    socket.destroy();
    return;
  }
  
  const session = sessions.get(sessionId);
  if (!session) {
    socket.destroy();
    return;
  }
  
  // Validate token (prefer header, fallback to query param)
  const authHeader = req.headers.authorization;
  let tokenValid = false;
  
  if (authHeader?.startsWith("Bearer ")) {
    const headerToken = authHeader.slice(7);
    tokenValid = headerToken === session.token || headerToken === getSecret("AUTH_TOKEN");
  } else if (token) {
    // Fallback to query param (less secure, exposed in logs/proxies)
    tokenValid = token === session.token || token === getSecret("AUTH_TOKEN");
  }
  
  if (!tokenValid) {
    socket.destroy();
    return;
  }
  
  // WebSocket rate limiting (100 messages per minute per session)
  const wsKey = `ws:${sessionId}`;
  
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req, session, wsKey);
  });
});

// WebSocket connection handling
wss.on("connection", (ws: WebSocket, _req: IncomingMessage, session: { id: string; send(message: unknown): void }, wsKey: string) => {
  // Track message count for rate limiting
  let messageCount = 0;
  let resetTime = Date.now() + 60_000;
  
  ws.on("message", (data) => {
    // Check rate limit
    const now = Date.now();
    if (now > resetTime) {
      messageCount = 0;
      resetTime = now + 60_000;
    }
    
    if (messageCount >= 100) {
      ws.send(JSON.stringify({ type: "error", message: "Rate limit exceeded" }));
      return;
    }
    
    // Check message size (100KB limit)
    if (data instanceof Buffer && data.length > 100 * 1024) {
      ws.send(JSON.stringify({ type: "error", message: "Message too large" }));
      return;
    }
    
    messageCount++;
    
    // Forward to agent
    try {
      const msg = JSON.parse(String(data));
      session.send(msg);
    } catch {
      ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
    }
  });
  
  // Echo back session events
  const originalSend = session.send.bind(session);
  session.send = (message: unknown) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
    return originalSend(message);
  };
  
  ws.on("close", () => {
    // Cleanup: restore original send
    session.send = originalSend;
  });
});

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("SIGTERM received, shutting down gracefully");
  server.close(() => {
    console.log("Server closed");
    process.exit(0);
  });
  
  // Close all WebSocket connections
  wss.clients.forEach((client) => {
    client.close();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
