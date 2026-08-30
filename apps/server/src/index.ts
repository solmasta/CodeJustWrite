import http from 'http';
import express, { Request, Response, NextFunction } from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { Agent, ToolContext } from '@codejustwrite/core';
import { SessionManager } from './session';
import { withGithubToken, redactSecrets } from './secrets';
import { requireAuth, checkWsToken } from './auth';

// Configuration
const WORKSPACES_DIR = '/tmp/cjw-workspaces';
const SESSION_TTL_MINUTES = 60;
const MAX_SESSIONS = 50;
const PORT = parseInt(process.env.PORT || '3000', 10);
const SERVER_TOKEN = process.env.SERVER_TOKEN || '';
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';

// Rate limiting
const rateLimitMap = new Map<string, { count: number; resetTime: number }>();
const RATE_LIMIT = 60;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;

// Message flood protection per WebSocket
const wsMessageMap = new Map<WebSocket, { count: number; resetTime: number }>();
const WS_RATE_LIMIT = 100;
const WS_RATE_LIMIT_WINDOW_MS = 60 * 1000;

// Max message size (100KB)
const MAX_MESSAGE_SIZE = 100 * 1024;

// Session manager with 4 required arguments
const config = {
  provider: (process.env.LLM_PROVIDER || 'openai') as 'openai' | 'deepinfra' | 'openrouter',
  model: process.env.LLM_MODEL || 'gpt-4o-mini',
  apiKey: process.env.OPENAI_API_KEY || process.env.DEEPINFRA_API_KEY || process.env.OPENROUTER_API_KEY || '',
  shellTimeoutSec: parseInt(process.env.SHELL_TIMEOUT_SEC || '30', 10),
  maxOutputChars: parseInt(process.env.MAX_OUTPUT_CHARS || '50000', 10),
};
const sessions = new SessionManager(WORKSPACES_DIR, config, SESSION_TTL_MINUTES * 60 * 1000, MAX_SESSIONS);

// Logging
function log(level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'AUDIT', type: string, data: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    type,
    ...data,
  }));
}

function logRequest(req: Request, status: number, duration: number): void {
  log('INFO', 'http_request', {
    method: req.method,
    path: req.path,
    status,
    duration,
    userAgent: req.headers['user-agent'],
  });
}

function logAudit(action: string, data: Record<string, unknown> = {}): void {
  log('AUDIT', 'audit', { action, ...data });
}

// Rate limiting middleware
function rateLimitMiddleware(req: Request, res: Response, next: NextFunction): void {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const entry = rateLimitMap.get(ip);

  if (!entry || now > entry.resetTime) {
    rateLimitMap.set(ip, { count: 1, resetTime: now + RATE_LIMIT_WINDOW_MS });
    next();
    return;
  }

  entry.count++;
  if (entry.count > RATE_LIMIT) {
    log('WARN', 'rate_limit', { ip, path: req.path });
    res.status(429).json({ error: 'Too many requests' });
    return;
  }

  // Cleanup old entries periodically
  if (Math.random() < 0.01) {
    for (const [key, value] of rateLimitMap.entries()) {
      if (now > value.resetTime) rateLimitMap.delete(key);
    }
  }

  next();
}

// Health check
async function checkHealth(): Promise<{ status: string; checks: Record<string, { status: string; latency: number }> }> {
  const checks: Record<string, { status: string; latency: number }> = {};
  const start = Date.now();

  // Check GitHub API
  try {
    if (GITHUB_TOKEN) {
      const response = await fetch('https://api.github.com/repos/render/render-mcp-server', {
        headers: { Authorization: `Bearer ${GITHUB_TOKEN}` },
      });
      checks.github = { status: response.ok ? 'ok' : 'unavailable', latency: Date.now() - start };
    } else {
      checks.github = { status: 'not_configured', latency: 0 };
    }
  } catch {
    checks.github = { status: 'error', latency: Date.now() - start };
  }

  // Memory check
  const memStart = Date.now();
  const memoryMB = Math.round((process.memoryUsage().heapUsed / 1024 / 1024) * 10) / 10;
  checks.memory = { status: 'ok', latency: Date.now() - memStart };

  return {
    status: 'ok',
    checks,
  };
}

// Express app
const app = express();

app.use(express.json({ limit: MAX_MESSAGE_SIZE }));
app.use(express.urlencoded({ extended: true }));
app.use(rateLimitMiddleware);

// CORS
app.use((req: Request, res: Response, next: NextFunction) => {
  res.header('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
    return;
  }
  next();
});

// Security headers
app.use((req: Request, res: Response, next: NextFunction) => {
  res.header('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; img-src 'self' data:;");
  res.header('X-Frame-Options', 'DENY');
  res.header('X-Content-Type-Options', 'nosniff');
  res.header('Referrer-Policy', 'no-referrer');
  next();
});

// Auth middleware
const AUTH_TOKEN = SERVER_TOKEN;
function requireToken(req: Request, res: Response, next: NextFunction): void {
  if (!AUTH_TOKEN) {
    next();
    return;
  }
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ') || auth.slice(7) !== AUTH_TOKEN) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}

// Auth status check
app.get('/api/auth/status', requireToken, (_req: Request, res: Response) => {
  res.json({ status: 'ok', message: 'Server token configured' });
});

// Health check endpoint
app.get('/api/health', async (_req: Request, res: Response) => {
  const start = Date.now();
  const health = await checkHealth();
  res.json({
    ...health,
    uptime: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

// Repository browsing
app.get('/api/repos', withGithubToken(GITHUB_TOKEN), async (req: Request, res: Response) => {
  try {
    const response = await fetch('https://api.github.com/user/repos?per_page=100&sort=updated', {
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: 'application/vnd.github.v3+json',
      },
    });

    if (!response.ok) {
      res.status(response.status).json({ error: 'Failed to fetch repos' });
      return;
    }

    const repos = await response.json();
    res.json(repos.map((r: { full_name: string; description: string; private: boolean; default_branch: string }) => ({
      name: r.full_name,
      description: r.description,
      private: r.private,
      defaultBranch: r.default_branch,
    })));
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch repos' });
  }
});

// Serve static files
app.use(express.static('dist'));

// Catch-all for SPA
app.get('*', (_req: Request, res: Response) => {
  res.sendFile('dist/index.html');
});

// Error handler
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  log('ERROR', 'error', { error: err.message, stack: err.stack });
  res.status(500).json({ error: 'Internal server error' });
});

// HTTP server
const server = http.createServer(app);

// WebSocket handling
const wss = new WebSocketServer({ server });

wss.on('connection', (socket, req) => {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  const sessionId = url.searchParams.get('sessionId');
  const token = url.searchParams.get('token');

  if (!sessionId || !checkWsToken(AUTH_TOKEN, token || '')) {
    socket.close(1008, 'Unauthorized');
    return;
  }

  let session = sessions.get(sessionId);
  if (!session) {
    socket.close(1008, 'Session not found');
    return;
  }

  logAudit('ws_connect', { sessionId, repoUrl: session.repoUrl, branch: session.branch });
  log('INFO', 'ws_connect', { sessionId });

  socket.on('message', (data) => {
    const now = Date.now();
    const entry = wsMessageMap.get(socket);

    if (!entry || now > entry.resetTime) {
      wsMessageMap.set(socket, { count: 1, resetTime: now + WS_RATE_LIMIT_WINDOW_MS });
    } else {
      entry.count++;
      if (entry.count > WS_RATE_LIMIT) {
        log('WARN', 'ws_rate_limit', { sessionId });
        socket.send(JSON.stringify({ type: 'error', error: 'Too many messages' }));
        return;
      }
    }

    if (data.toString().length > MAX_MESSAGE_SIZE) {
      socket.send(JSON.stringify({ type: 'error', error: 'Message too large' }));
      return;
    }

    try {
      const msg = JSON.parse(data.toString());
      handleMessage(socket, session!, msg, GITHUB_TOKEN);
    } catch {
      socket.send(JSON.stringify({ type: 'error', error: 'Invalid JSON' }));
    }
  });

  socket.on('close', () => {
    wsMessageMap.delete(socket);
    logAudit('ws_disconnect', { sessionId });
    log('INFO', 'ws_disconnect', { sessionId });
  });

  socket.on('error', (err) => {
    log('ERROR', 'ws_error', { sessionId, error: err.message });
  });
});

async function handleMessage(socket: WebSocket, session: { repoUrl: string; branch: string; workspaceDir: string }, msg: { type: string; text?: string; toolCalls?: unknown[] }, githubToken: string): Promise<void> {
  try {
    if (msg.type === 'ping') {
      socket.send(JSON.stringify({ type: 'pong' }));
      return;
    }

    if (msg.type !== 'message' || !msg.text) {
      socket.send(JSON.stringify({ type: 'error', error: 'Invalid message type' }));
      return;
    }

    const ctx: ToolContext = {
      repoRoot: session.workspaceDir,
      config: { shellTimeoutSec: 30, maxOutputChars: 50000 },
      githubToken,
    };

    const agent = new Agent({
      provider: config.provider,
      model: config.model,
      apiKey: config.apiKey,
    });

    socket.send(JSON.stringify({ type: 'assistant_start' }));

    for await (const chunk of agent.run(session.repoUrl, session.branch, msg.text, ctx)) {
      if (chunk.type === 'assistant_delta') {
        socket.send(JSON.stringify({ type: 'assistant_delta', text: chunk.text }));
      } else if (chunk.type === 'tool_start') {
        socket.send(JSON.stringify({ type: 'tool_start', name: chunk.name, args: chunk.args }));
      } else if (chunk.type === 'tool_end') {
        socket.send(JSON.stringify({ type: 'tool_end', result: chunk.result }));
      }
    }

    socket.send(JSON.stringify({ type: 'assistant_end' }));
  } catch (error) {
    socket.send(JSON.stringify({ type: 'error', error: String(error) }));
  }
}

// Graceful shutdown
process.on('SIGTERM', () => {
  log('INFO', 'shutdown', { message: 'SIGTERM received, closing server' });
  wss.clients.forEach((client) => client.close(1001, 'Server shutting down'));
  server.close(() => {
    log('INFO', 'shutdown', { message: 'Server closed' });
    process.exit(0);
  });
});

server.listen(PORT, () => {
  log('INFO', 'start', { message: `Server started on port ${PORT}` });
  logAudit('server_start', { port: PORT });
});