import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { WebSocket } from "ws";
import {
  Agent,
  ProviderRegistry,
  defaultModelFor,
  execSandboxed,
  type CjwConfig,
  type ProviderName,
  type ToolContext,
} from "@codejustwrite/core";
import { redactSecrets, withGithubToken } from "./secrets.js";

export interface PendingConfirmation {
  resolve: (approved: boolean) => void;
}

export class Session {
  readonly id = randomUUID();
  readonly createdAt = Date.now();
  lastActiveAt = Date.now();
  autoApprove = false;
  provider: ProviderName;
  model: string;
  ws: WebSocket | null = null;

  private agent: Agent;
  private pendingConfirmations = new Map<string, PendingConfirmation>();
  private readonly secrets: string[];

  constructor(
    readonly repoRoot: string,
    private readonly registry: ProviderRegistry,
    config: CjwConfig
  ) {
    this.provider = config.provider;
    this.model = config.model;
    this.secrets = [config.githubToken, config.openaiApiKey, config.deepinfraApiKey, config.openrouterApiKey].filter(
      (s): s is string => !!s
    );

    const ctx: ToolContext = {
      repoRoot: this.repoRoot,
      config,
      log: (line: string) => this.send({ type: "diff", text: line }),
      confirm: (question: string) => this.requestConfirmation(question),
    };

    this.agent = new Agent({
      getProvider: () => this.registry.get(this.provider),
      getModel: () => this.model,
      ctx,
      onTextDelta: (delta) => this.send({ type: "assistant_delta", text: delta }),
      onToolCall: (name, args) => this.send({ type: "tool_call", name, args }),
      onToolResult: (name, result, error) => this.send({ type: "tool_result", name, result, error }),
    });
  }

  touch(): void {
    this.lastActiveAt = Date.now();
  }

  attach(ws: WebSocket): void {
    this.ws = ws;
    this.send({
      type: "state",
      provider: this.provider,
      model: this.model,
      autoApprove: this.autoApprove,
      repoRoot: this.repoRoot,
    });
  }

  detach(ws: WebSocket): void {
    if (this.ws === ws) this.ws = null;
  }

  send(message: Record<string, unknown>): void {
    if (this.ws && this.ws.readyState === this.ws.OPEN) {
      this.ws.send(JSON.stringify(redactSecrets(message, this.secrets)));
    }
  }

  setProvider(provider: ProviderName): void {
    this.provider = provider;
    this.model = defaultModelFor(provider);
  }

  setModel(model: string): void {
    this.model = model;
  }

  setAutoApprove(value: boolean): void {
    this.autoApprove = value;
    // Resolve any confirmations already waiting when auto-approve flips on.
    if (value) {
      for (const [id, pending] of this.pendingConfirmations) {
        pending.resolve(true);
        this.pendingConfirmations.delete(id);
      }
    }
  }

  resolveConfirmation(callId: string, approved: boolean): void {
    const pending = this.pendingConfirmations.get(callId);
    if (!pending) return;
    this.pendingConfirmations.delete(callId);
    pending.resolve(approved);
  }

  async handleUserMessage(text: string): Promise<void> {
    this.touch();
    try {
      const finalText = await this.agent.send(text);
      this.send({ type: "assistant_done", text: finalText });
    } catch (err) {
      this.send({ type: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }

  private requestConfirmation(question: string): Promise<boolean> {
    if (this.autoApprove) return Promise.resolve(true);

    const callId = randomUUID();
    this.send({ type: "awaiting_confirmation", callId, question });
    return new Promise((resolve) => {
      this.pendingConfirmations.set(callId, { resolve });
    });
  }

  async dispose(): Promise<void> {
    this.ws?.close();
    await fs.rm(this.repoRoot, { recursive: true, force: true });
  }
}

export class SessionManager {
  private sessions = new Map<string, Session>();
  private registry: ProviderRegistry;
  private sweepTimer: NodeJS.Timeout;

  constructor(
    private readonly workspacesDir: string,
    private readonly config: CjwConfig,
    private readonly ttlMs: number,
    private readonly maxSessions: number
  ) {
    this.registry = new ProviderRegistry(config);
    this.sweepTimer = setInterval(() => void this.sweep(), 60_000);
    this.sweepTimer.unref();
  }

  get size(): number {
    return this.sessions.size;
  }

  async createSession(repoUrl: string, branch?: string): Promise<Session> {
    if (this.sessions.size >= this.maxSessions) {
      throw new Error(`Session limit reached (${this.maxSessions}). Try again once another session ends.`);
    }

    await fs.mkdir(this.workspacesDir, { recursive: true });
    const dir = path.join(this.workspacesDir, randomUUID());

    const authenticatedUrl = withGithubToken(repoUrl, this.config.githubToken);
    const branchFlag = branch ? ` --branch ${branch}` : "";
    const clone = await execSandboxed(`git clone --depth 50${branchFlag} "${authenticatedUrl}" "${dir}"`, {
      cwd: this.workspacesDir,
      timeoutSec: 120,
    });
    if (clone.code !== 0) {
      await fs.rm(dir, { recursive: true, force: true });
      const secrets = this.config.githubToken ? [this.config.githubToken] : [];
      throw new Error(
        `Failed to clone ${repoUrl}: ${redactSecrets(clone.stderr || clone.stdout, secrets)}`
      );
    }

    const session = new Session(dir, this.registry, this.config);
    this.sessions.set(session.id, session);
    return session;
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  async removeSession(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    await session.dispose();
  }

  private async sweep(): Promise<void> {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (now - session.lastActiveAt > this.ttlMs) {
        await this.removeSession(id);
      }
    }
  }
}
