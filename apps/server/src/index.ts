import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import express from "express";
import { WebSocketServer } from "ws";
import { randomUUID } from "node:crypto";
import { requireAuth, checkWsToken } from "./auth.js";
import { withGithubToken, redactSecrets } from "./secrets.js";
import { SessionManager } from "./session.js";
import type { CjwConfig } from "@codejustwrite/core";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Configuration
const PORT = Number(process.env.PORT) || 3000;
const AUTH_TOKEN = process.env.AUTH_TOKEN || "";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const DEEPINFRA_API_KEY = process.env.DEEPINFRA_API_KEY || "";
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "";
const SESSION_TTL_MINUTES = Number(process.env.SESSION_TTL_MINUTES) || 30;
const MAX_SESSIONS = Number(process.env.MAX_SESSIONS) || 50;
const WORKSPACES_DIR = process.env.WORKSPACES_DIR || "/tmp/cjw-workspaces";

const config: CjwConfig = {
  provider: "openai",
  model: "gpt-4o-mini",
  shellTimeoutSec: 120,
  testTimeoutSec: 60,
  githubToken: GITHUB_TOKEN,
  openaiApiKey: OPENAI_API_KEY,
  deepinfraApiKey: DEEPINFRA_API_KEY,
  openrouterApiKey: OPENROUTER_API_KEY,
};

const sessions = new SessionManager(WORKSPACES_DIR, config, SESSION_TTL_MINUTES * 60 * 1000, MAX_SESSIONS);

const app = express();
const server = createServer(app);

// Middleware
app.use(express.json({ limit: "100kb" }));
app.use(requireAuth(AUTH_TOKEN));

// Static files
app.use(express.static(join(__dirname, "../../web/dist")));

// Health check
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Create session
app.post("/api/session", async (req, res) => {
  const { repoUrl, branch } = req.body;
  if (!repoUrl || typeof repoUrl !== "string") {
    res.status(400).json({ error: "repoUrl is required" });
    return;
  }

  try {
    const session = await sessions.createSession(repoUrl, branch);
    res.json({ sessionId: session.id });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed to create session" });
  }
});

// Get session
app.get("/api/session/:id", (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  res.json({
    id: session.id,
    provider: session.provider,
    model: session.model,
    autoApprove: session.autoApprove,
    repoRoot: session.repoRoot,
  });
});

// Delete session
app.delete("/api/session/:id", async (req, res) => {
  try {
    await sessions.removeSession(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed to remove session" });
  }
});

// WebSocket server
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws, req) => {
  const sessionId = new URL(req.url || "", "http://localhost").searchParams.get("sessionId");
  const token = new URL(req.url || "", "http://localhost").searchParams.get("token");

  if (!sessionId || !checkWsToken(AUTH_TOKEN, token)) {
    ws.close(1008, "Invalid session or token");
    return;
  }

  const session = sessions.get(sessionId);
  if (!session) {
    ws.close(1008, "Session not found");
    return;
  }

  session.attach(ws);

  ws.on("message", async (data) => {
    try {
      const msg = JSON.parse(String(data));
      if (msg.type === "chat") {
        await session.handleUserMessage(msg.text);
      } else if (msg.type === "set_provider") {
        session.setProvider(msg.provider);
      } else if (msg.type === "set_model") {
        session.setModel(msg.model);
      } else if (msg.type === "set_auto_approve") {
        session.setAutoApprove(msg.value);
      } else if (msg.type === "resolve_confirmation") {
        session.resolveConfirmation(msg.callId, msg.approved);
      }
    } catch (err) {
      console.error("WebSocket message error:", err);
      session.send({ type: "error", message: "Invalid message format" });
    }
  });

  ws.on("close", () => {
    session.detach(ws);
  });

  ws.on("error", (err) => {
    console.error("WebSocket error:", err);
  });
});

// Start server
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
