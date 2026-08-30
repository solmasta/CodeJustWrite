import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { readFileSync } from "fs";
import { Agent, CjwConfig } from "@codejustwrite/core";
import { SessionManager } from "./session.js";
import { requireAuth, checkWsToken } from "./auth.js";
import { withGithubToken, redactSecrets } from "./secrets.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = parseInt(process.env.PORT || "3000", 10);
const AUTH_TOKEN = process.env.AUTH_TOKEN;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const WORKSPACES_DIR = process.env.WORKSPACES_DIR || "/tmp/cjw-workspaces";
const SESSION_TTL_MINUTES = parseInt(process.env.SESSION_TTL_MINUTES || "30", 10);
const MAX_SESSIONS = parseInt(process.env.MAX_SESSIONS || "50", 10);

const config: CjwConfig = {
  modelProvider: process.env.MODEL_PROVIDER as any || "openai",
  modelName: process.env.MODEL_NAME || "gpt-4",
  apiKey: process.env.API_KEY || "",
  temperature: parseFloat(process.env.TEMPERATURE || "0.7"),
  maxTokens: parseInt(process.env.MAX_TOKENS || "4000", 10),
  shellTimeoutSec: parseInt(process.env.SHELL_TIMEOUT_SEC || "30", 10),
  testTimeoutSec: parseInt(process.env.TEST_TIMEOUT_SEC || "60", 10),
};

const server = createServer();
const wss = new WebSocketServer({ server });

const agent = new Agent(config);
const sessions = new SessionManager(WORKSPACES_DIR, config, SESSION_TTL_MINUTES * 60 * 1000, MAX_SESSIONS);

server.on("request", async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  const pathname = url.pathname;

  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    res.writeHead(200);
    res.end();
    return;
  }

  // Health check
  if (pathname === "/api/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", timestamp: new Date().toISOString() }));
    return;
  }

  // Auth middleware for protected routes
  if (pathname.startsWith("/api/") && pathname !== "/api/health") {
    const authResult = requireAuth(AUTH_TOKEN, req);
    if (authResult.error) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: authResult.error }));
      return;
    }
  }

  // List user's GitHub repos
  if (pathname === "/api/repos") {
    try {
      const repos = await withGithubToken(GITHUB_TOKEN, async (token) => {
        const response = await fetch("https://api.github.com/user/repos?sort=updated&per_page=100", {
          headers: { Authorization: `token ${token}` },
        });
        if (!response.ok) throw new Error(`GitHub API error: ${response.status}`);
        return await response.json();
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(repos));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(error) }));
    }
    return;
  }

  // Start session
  if (pathname === "/api/session" && req.method === "POST") {
    const body = await new Promise<string>((resolve) => {
      let data = "";
      req.on("data", (chunk) => (data += chunk));
      req.on("end", () => resolve(data));
    });

    try {
      const { repoUrl, branch, provider, model, apiKey } = JSON.parse(body);
      const session = sessions.createSession(repoUrl, branch, { provider, model, apiKey });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ sessionId: session.id, token: session.token }));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(error) }));
    }
    return;
  }

  // Get session
  if (pathname.startsWith("/api/session/") && req.method === "GET") {
    const sessionId = pathname.split("/")[3];
    const session = sessions.getSession(sessionId);
    if (!session) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Session not found" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(session));
    return;
  }

  // Static files (web app)
  if (pathname === "/" || pathname === "/index.html") {
    try {
      const html = readFileSync(join(__dirname, "../public/index.html"), "utf-8");
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(html);
    } catch {
      res.writeHead(404);
      res.end("Not found");
    }
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

wss.on("connection", (ws: WebSocket, req) => {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  const sessionId = url.searchParams.get("sessionId");
  const token = url.searchParams.get("token");

  if (!sessionId || !token) {
    ws.close(1008, "Missing sessionId or token");
    return;
  }

  const authResult = checkWsToken(AUTH_TOKEN, token);
  if (authResult.error) {
    ws.close(1008, authResult.error);
    return;
  }

  const session = sessions.getSession(sessionId);
  if (!session) {
    ws.close(1008, "Invalid session");
    return;
  }

  ws.on("message", async (data) => {
    try {
      const { message } = JSON.parse(data.toString());
      const result = await agent.run(message, {
        repoRoot: session.workspacePath,
        config: session.config,
      });
      ws.send(JSON.stringify({ type: "response", data: redactSecrets(result) }));
    } catch (error) {
      ws.send(JSON.stringify({ type: "error", error: String(error) }));
    }
  });

  ws.on("close", () => {
    sessions.disposeSession(sessionId);
  });
});

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
