import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { WebSocket } from "ws";
import {
  Agent,
  ProviderRegistry,
  allTools,
  buildSystemPrompt,
  connectMcpServers,
  defaultModelFor,
  execSandboxed,
  log,
  DEFAULT_PROMPT_PRESET_ID,
  PROMPT_PRESETS,
  type CjwConfig,
  type ModelInfo,
  type ProviderName,
  type ToolContext,
  type ToolDefinition,
} from "@codejustwrite/core";
import { redactSecrets, withGithubToken } from "./secrets.js";
import { TranscriptRecorder, renderTranscriptMarkdown } from "./transcript.js";

export interface PendingConfirmation {
  resolve: (approved: boolean) => void;
}

export class Session {
  readonly id = randomUUID();
  readonly createdAt = Date.now();
  lastActiveAt = Date.now();
  autoApprove = false;
  /** True for the duration of one agent.send() turn — a reconnecting client uses this (sent in
   *  the "state" message) to restore its "AI is thinking…" indicator instead of it silently
   *  disappearing on reload while a reply is still in flight. */
  busy = false;
  provider: ProviderName;
  model: string;
  promptPreset: string = DEFAULT_PROMPT_PRESET_ID;
  customInstructions = "";
  ws: WebSocket | null = null;

  private agent: Agent;
  private readonly transcript = new TranscriptRecorder();
  private pendingConfirmations = new Map<string, PendingConfirmation>();
  private readonly secrets: string[];

  constructor(
    readonly repoRoot: string,
    private readonly registry: ProviderRegistry,
    config: CjwConfig,
    mcpTools: ToolDefinition[] = []
  ) {
    this.provider = config.provider;
    this.model = config.model;
    this.secrets = [config.githubToken, config.deepinfraApiKey, config.openrouterApiKey].filter(
      (s): s is string => !!s
    );

    const ctx: ToolContext = {
      repoRoot: this.repoRoot,
      config,
      log: (line: string) => {
        this.transcript.diff(line);
        this.send({ type: "diff", text: line });
      },
      confirm: (question: string) => this.requestConfirmation(question),
    };

    this.agent = new Agent({
      getProvider: () => this.registry.get(this.provider),
      getModel: () => this.model,
      ctx,
      tools: [...allTools, ...mcpTools],
      systemPrompt: buildSystemPrompt(this.promptPreset, this.customInstructions),
      onTextDelta: (delta) => {
        this.transcript.assistantDelta(delta);
        this.send({ type: "assistant_delta", text: delta });
      },
      onToolCall: (name, args, callId) => {
        this.transcript.toolCall(name, args);
        this.send({ type: "tool_call", name, args, callId });
      },
      onToolResult: (name, result, error, callId) => {
        this.transcript.toolResult(name, result, error);
        this.send({ type: "tool_result", name, result, error, callId });
      },
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
      busy: this.busy,
      repoRoot: this.repoRoot,
      promptPreset: this.promptPreset,
      customInstructions: this.customInstructions,
      promptPresets: PROMPT_PRESETS,
    });
    // Replays the conversation so far into a client that just (re)connected — most importantly a
    // page that was freshly reloaded, whose chat feed would otherwise start out empty even though
    // the Agent's own conversation history is still fully intact on this end.
    const entries = this.transcript.getEntries();
    if (entries.length) {
      this.send({ type: "history", entries, assistantOpen: this.transcript.assistantOpen });
    }
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

  /** Live model catalog for the given provider (not necessarily the session's active one — the
   *  settings UI needs to list models for whichever provider is currently selected there). */
  async listModels(provider: ProviderName): Promise<ModelInfo[]> {
    return this.registry.get(provider).listModels();
  }

  /** Switches prompt mode/custom instructions in place — the agent picks it up on its next
   *  reply without losing the conversation so far (unlike starting a fresh session). */
  setPromptMode(promptPreset: string, customInstructions: string): void {
    this.promptPreset = promptPreset;
    this.customInstructions = customInstructions;
    this.agent.setSystemPrompt(buildSystemPrompt(promptPreset, customInstructions));
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
    this.busy = true;
    this.transcript.user(text);
    try {
      const finalText = await this.agent.send(text);
      this.transcript.turnEnded();
      this.send({ type: "assistant_done", text: finalText });
    } catch (err) {
      this.transcript.turnEnded();
      this.send({ type: "error", message: err instanceof Error ? err.message : String(err) });
    } finally {
      this.busy = false;
    }
  }

  /** Renders the conversation so far into a Markdown note for the "export/save locally"
   *  download — see renderTranscriptMarkdown for what it does and doesn't include. */
  buildExportMarkdown(repoName: string): string {
    return renderTranscriptMarkdown(this.transcript.getEntries(), repoName, this.createdAt);
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
  /** Connected once and shared across every session — MCP servers are a deployment-wide
   *  concern (same connectors regardless of which repo/session is asking), not per-session
   *  state, so this avoids spawning a fresh stdio subprocess per session. */
  private readonly mcp: ReturnType<typeof connectMcpServers>;

  constructor(
    private readonly workspacesDir: string,
    private readonly config: CjwConfig,
    private readonly ttlMs: number,
    private readonly maxSessions: number
  ) {
    this.registry = new ProviderRegistry(config);
    this.mcp = connectMcpServers(config.mcpServers);
    void this.mcp.then((mcp) => {
      for (const status of mcp.statuses) {
        if (status.connected) {
          log.dim(`[mcp] ${status.name}: connected (${status.toolCount} tool(s))`);
        } else {
          log.error(`[mcp] ${status.name}: failed to connect — ${status.error}`);
        }
      }
    });
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

    const mcpTools = (await this.mcp).tools;
    const session = new Session(dir, this.registry, this.config, mcpTools);
    this.sessions.set(session.id, session);
    return session;
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  /** Disconnects every configured MCP server (stdio subprocesses / HTTP sessions). Call on shutdown. */
  async closeMcp(): Promise<void> {
    await (await this.mcp).close();
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
