import "./style.css";
import { loadSettings, saveSettings, httpBase, wsBase, type Settings } from "./settings.js";

const app = document.getElementById("app")!;
const settings = loadSettings();
let socket: WebSocket | null = null;
let lastToolCard: HTMLElement | null = null;
let currentAssistantBubble: HTMLElement | null = null;

// ---------- DOM utilities ----------

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  Object.assign(node, props);
  for (const child of children) node.append(child);
  return node;
}

function on<E extends Event>(target: EventTarget, event: string, handler: E extends Event ? (e: E) => void : never): void {
  target.addEventListener(event, handler as EventListener);
}

// ---------- Settings helpers ----------

function persistSettings(updates: Partial<Settings>): void {
  Object.assign(settings, updates);
  saveSettings(settings);
}

// ---------- API helpers ----------

async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${httpBase(settings)}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(settings.token ? { authorization: `Bearer ${settings.token}` } : {}),
      ...options?.headers,
    },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data as T;
}

// ---------- Recent repos ----------

interface RepoInfo {
  fullName: string;
  cloneUrl: string;
  defaultBranch: string;
  private: boolean;
}

function getRecentRepos(): RepoInfo[] {
  try {
    return JSON.parse(localStorage.getItem("cjw.recent") || "[]");
  } catch {
    return [];
  }
}

function addRecentRepo(repo: RepoInfo): void {
  try {
    const recent = getRecentRepos().filter((r) => r.fullName !== repo.fullName);
    recent.unshift(repo);
    localStorage.setItem("cjw.recent", JSON.stringify(recent.slice(0, 5)));
  } catch {
    // localStorage unavailable
  }
}

// ---------- Sign-in screen ----------

function renderSignIn(errorMessage?: string): void {
  app.innerHTML = "";

  const serverInput = el("input", { placeholder: "server URL (leave blank for same origin)", value: settings.serverUrl });
  const tokenInput = el("input", { type: "password", placeholder: "server token (if required)", value: settings.token });
  const errorDiv = errorMessage ? el("div", { className: "error", textContent: errorMessage }) : null;

  const form = el(
    "div",
    { className: "setup sign-in" },
    el("h2", { textContent: "CodeJustWrite" }),
    el("p", { textContent: "Sign in to access your repositories." }),
    el("label", {}, "Server URL", serverInput),
    el("label", {}, "Access token", tokenInput),
    errorDiv,
    el(
      "div",
      { className: "btn-row" },
      el("button", { className: "primary", textContent: "Continue" }, onClick(() => handleSignIn())),
      el("button", { className: "secondary", textContent: "Skip sign-in" }, onClick(() => handleSkip()))
    )
  );
  app.append(form);

  async function handleSignIn(): Promise<void> {
    persistSettings({ serverUrl: serverInput.value.trim(), token: tokenInput.value.trim() });
    try {
      await apiFetch<{ ok: boolean }>("/api/auth/status");
      renderRepoSelect();
    } catch (err) {
      renderSignIn(err instanceof Error ? err.message : String(err));
    }
  }

  function handleSkip(): void {
    persistSettings({ serverUrl: serverInput.value.trim(), token: tokenInput.value.trim() });
    renderRepoSelect();
  }
}

// ---------- Repository selection screen ----------

function renderRepoSelect(errorMessage?: string): void {
  app.innerHTML = "";

  const repoInput = el("input", { placeholder: "https://github.com/you/repo.git", value: settings.repoUrl });
  const branchInput = el("input", { placeholder: "main (optional)", value: settings.branch });
  const searchInput = el("input", { placeholder: "Search repositories…", value: "" });
  const repoList = el("div", { className: "repo-list" });
  const recentList = el("div", { className: "repo-list recent" });
  const statusDiv = el("div", { className: "repo-status" });
  const errorDiv = errorMessage ? el("div", { className: "error", textContent: errorMessage }) : null;

  const form = el(
    "div",
    { className: "setup repo-select" },
    el("h2", { textContent: "Choose a repository" }),
    el("label", {}, "Repo URL", repoInput),
    el("button", { className: "secondary", textContent: "Browse my repos" }, onClick(browseRepos)),
    repoList,
    statusDiv,
    el(
      "div",
      { className: "row" },
      el("label", {}, "Branch", branchInput),
      el("button", { className: "text-btn small", textContent: "Sign out" }, onClick(signOut))
    ),
    errorDiv,
    el("button", { className: "primary", textContent: "Start session" }, onClick(startSession))
  );
  app.append(form);

  function signOut(): void {
    persistSettings({ token: "" });
    renderSignIn();
  }

  async function browseRepos(): Promise<void> {
    repoList.innerHTML = "";
    statusDiv.textContent = "Loading repositories…";
    statusDiv.className = "repo-status";

    try {
      const data = await apiFetch<{ repos: RepoInfo[] }>("/api/repos");
      statusDiv.textContent = "";

      if (!data.repos.length) {
        statusDiv.textContent = "No repositories found.";
        return;
      }

      const searchContainer = el("div", { className: "search-container" }, searchInput);
      form.insertBefore(searchContainer, repoList);
      searchInput.addEventListener("input", () => filterRepos(data.repos));
      filterRepos(data.repos);

      const recent = getRecentRepos();
      if (recent.length) {
        const header = el("div", { className: "section-header", textContent: "Recent" });
        form.insertBefore(header, searchContainer);
        form.insertBefore(recentList, searchContainer);
        renderRepoItems(recent, recentList);
      }
    } catch (err) {
      statusDiv.textContent = err instanceof Error ? err.message : String(err);
      statusDiv.className = "repo-status error";
    }
  }

  function filterRepos(repos: RepoInfo[]): void {
    repoList.innerHTML = "";
    const query = searchInput.value.toLowerCase().trim();
    const filtered = query ? repos.filter((r) => r.fullName.toLowerCase().includes(query)) : repos;

    if (!filtered.length) {
      repoList.append(el("div", { className: "repo-status", textContent: query ? "No matching repos." : "" }));
      return;
    }
    renderRepoItems(filtered, repoList);
  }

  function renderRepoItems(repos: RepoInfo[], container: HTMLElement): void {
    for (const repo of repos) {
      const item = el(
        "button",
        { className: "repo-item", type: "button" },
        el("span", { className: "name", textContent: repo.fullName }),
        el("span", { className: "meta", textContent: repo.private ? "private" : "public" })
      );
      item.addEventListener("click", () => selectRepo(repo));
      container.append(item);
    }
  }

  function selectRepo(repo: RepoInfo): void {
    repoInput.value = repo.cloneUrl;
    branchInput.value = repo.defaultBranch;
    persistSettings({ repoUrl: repo.cloneUrl, branch: repo.defaultBranch });
    addRecentRepo(repo);
  }

  async function startSession(): Promise<void> {
    persistSettings({ repoUrl: repoInput.value.trim(), branch: branchInput.value.trim() });

    if (!settings.repoUrl) {
      renderRepoSelect("Repo URL is required.");
      return;
    }

    const btn = form.querySelector(".primary") as HTMLButtonElement;
    btn.textContent = "Cloning…";
    btn.disabled = true;

    try {
      const data = await apiFetch<{ sessionId: string; provider: string; model: string }>("/api/sessions", {
        method: "POST",
        body: JSON.stringify({ repoUrl: settings.repoUrl, branch: settings.branch || undefined }),
      });
      persistSettings({ sessionId: data.sessionId, provider: data.provider as Settings["provider"], model: data.model });
      connect();
    } catch (err) {
      renderRepoSelect(err instanceof Error ? err.message : String(err));
    }
  }
}

// ---------- Chat screen ----------

function renderChat(): void {
  app.innerHTML = "";

  const messages = el("div", { className: "messages" });
  const topbar = el(
    "div",
    { className: "topbar" },
    el("div", {}, el("h1", { textContent: "CodeJustWrite" }), el("div", { className: "sub", textContent: `${settings.provider}:${settings.model}` })),
    el("button", { className: "icon-btn", textContent: "⚙" }, onClick(openDrawer))
  );
  const composer = el(
    "div",
    { className: "composer" },
    el("textarea", { rows: 1, placeholder: "Ask the agent to do something…" }, onKeydown(sendMessage)),
    el("button", { textContent: "➤" }, onClick(sendMessage))
  );

  app.append(topbar, messages, composer);

  function sendMessage(): void {
    const textarea = app.querySelector(".composer textarea") as HTMLTextAreaElement;
    const text = textarea.value.trim();
    if (!text || !socket || socket.readyState !== WebSocket.OPEN) return;
    addBubble("user", text);
    socket.send(JSON.stringify({ type: "user_message", text }));
    textarea.value = "";
    currentAssistantBubble = null;
  }
}

function onClick(handler: () => void): void {
  return { addEventListener: () => {} } as never;
}

function onKeydown(handler: () => void): void {
  return {
    addEventListener(_event: string, fn: EventListener) {
      (this as HTMLTextAreaElement).addEventListener("keydown", (e: Event) => {
        const ke = e as KeyboardEvent;
        if (ke.key === "Enter" && !ke.shiftKey) {
          e.preventDefault();
          fn(e);
        }
      });
    },
  } as never;
}

function scrollToBottom(): void {
  const messages = document.querySelector(".messages");
  messages?.scrollTo({ top: messages.scrollHeight });
}

function addBubble(kind: "user" | "assistant" | "system" | "error", text: string): HTMLElement {
  const bubble = el("div", { className: `bubble ${kind}`, textContent: text });
  document.querySelector(".messages")?.append(bubble);
  scrollToBottom();
  return bubble;
}

function addToolCard(name: string, args: unknown): HTMLElement {
  const card = el(
    "div",
    { className: "tool-card" },
    el("div", { className: "head" }, el("span", { textContent: `→ ${name}` }), el("span", { className: "status", textContent: "running…" })),
    el("div", { className: "body", textContent: JSON.stringify(args) })
  );
  document.querySelector(".messages")?.append(card);
  scrollToBottom();
  return card;
}

function addConfirmCard(callId: string, question: string): void {
  const status = el("span", { className: "status", textContent: "awaiting approval" });
  const card = el(
    "div",
    { className: "tool-card" },
    el("div", { className: "head" }, el("span", { textContent: "⚠ confirm" }), status),
    el("div", { className: "body", textContent: question }),
    el(
      "div",
      { className: "confirm-row" },
      el("button", { className: "approve", textContent: "Approve" }, onClick(() => decide(true))),
      el("button", { className: "deny", textContent: "Deny" }, onClick(() => decide(false)))
    )
  );
  document.querySelector(".messages")?.append(card);
  scrollToBottom();

  function decide(approved: boolean): void {
    socket?.send(JSON.stringify({ type: "tool_decision", callId, approved }));
    status.textContent = approved ? "approved" : "denied";
    card.querySelector(".confirm-row")?.remove();
  }
}

// ---------- Settings drawer ----------

function openDrawer(): void {
  const backdrop = el("div", { className: "drawer-backdrop" }, onClick(closeDrawer));
  const autoApproveInput = el("input", { type: "checkbox", checked: settings.autoApprove });
  const providerSelect = el(
    "select", {},
    el("option", { value: "openai", textContent: "OpenAI" }),
    el("option", { value: "deepinfra", textContent: "DeepInfra" }),
    el("option", { value: "openrouter", textContent: "OpenRouter" })
  );
  providerSelect.value = settings.provider;

  const drawer = el(
    "div",
    { className: "drawer" },
    el("h2", { textContent: "Settings" }),
    el(
      "div",
      { className: "toggle-row" },
      el("span", { textContent: "Auto-approve all actions" }),
      el("label", { className: "switch" }, autoApproveInput, el("span", { className: "slider" }))
    ),
    el("label", {}, "Provider", providerSelect),
    el("label", {}, "Model", el("input", { value: settings.model })),
    el("div", { className: "sub", textContent: `Repo: ${settings.repoUrl}` }),
    el("button", { className: "danger-btn", textContent: "End session" }, onClick(endSession))
  );

  backdrop.addEventListener("click", closeDrawer);
  autoApproveInput.addEventListener("change", () => {
    persistSettings({ autoApprove: autoApproveInput.checked });
    socket?.send(JSON.stringify({ type: "set_auto_approve", value: settings.autoApprove }));
  });
  providerSelect.addEventListener("change", () => {
    persistSettings({ provider: providerSelect.value as Settings["provider"] });
    socket?.send(JSON.stringify({ type: "set_provider", provider: settings.provider }));
  });

  const modelInput = drawer.querySelector('input[type="text"]') as HTMLInputElement;
  modelInput.addEventListener("change", () => {
    persistSettings({ model: modelInput.value.trim() });
    socket?.send(JSON.stringify({ type: "set_model", model: settings.model }));
  });

  document.body.append(backdrop, drawer);

  function closeDrawer(): void {
    backdrop.remove();
    drawer.remove();
  }

  async function endSession(): Promise<void> {
    if (settings.sessionId) {
      await apiFetch(`/api/sessions/${settings.sessionId}`, { method: "DELETE" }).catch(() => {});
    }
    persistSettings({ sessionId: "" });
    socket?.close();
    renderRepoSelect();
  }
}

// ---------- WebSocket ----------

function connect(): void {
  renderChat();
  socket = new WebSocket(`${wsBase(settings)}/ws?sessionId=${encodeURIComponent(settings.sessionId)}&token=${encodeURIComponent(settings.token)}`);

  socket.addEventListener("message", (event) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }

    switch (msg.type) {
      case "state":
        persistSettings({ provider: msg.provider as Settings["provider"], model: String(msg.model) });
        (document.querySelector(".topbar .sub") as HTMLElement).textContent = `${settings.provider}:${settings.model}`;
        break;
      case "assistant_delta":
        currentAssistantBubble ??= addBubble("assistant", "");
        currentAssistantBubble.textContent += String(msg.text ?? "");
        scrollToBottom();
        break;
      case "assistant_done":
        currentAssistantBubble = null;
        break;
      case "tool_call":
        lastToolCard = addToolCard(String(msg.name), msg.args);
        break;
      case "tool_result":
        if (lastToolCard) {
          const status = lastToolCard.querySelector(".status");
          const body = lastToolCard.querySelector(".body");
          if (status) {
            status.textContent = msg.error ? "error" : "done";
            status.className = `status ${msg.error ? "err" : "ok"}`;
          }
          if (body) body.textContent += `\n\n${String(msg.result ?? "")}`;
        }
        break;
      case "diff":
        lastToolCard?.querySelector(".body")!.textContent += `\n\n${String(msg.text ?? "")}`;
        break;
      case "awaiting_confirmation":
        addConfirmCard(String(msg.callId), String(msg.question ?? "Allow this action?"));
        break;
      case "error":
        addBubble("error", String(msg.message ?? "Unknown error"));
        break;
    }
  });

  socket.addEventListener("close", () => addBubble("system", "Disconnected. Reload to reconnect."));
  socket.addEventListener("error", () => addBubble("error", "Connection error."));
}

// ---------- Boot ----------

if (settings.sessionId) {
  connect();
} else if (settings.token) {
  renderRepoSelect();
} else {
  renderSignIn();
}