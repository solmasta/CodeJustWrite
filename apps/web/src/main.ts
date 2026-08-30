import "./style.css";
import { loadSettings, saveSettings, httpBase, wsBase, type Settings } from "./settings.js";

const app = document.getElementById("app")!;
const settings = loadSettings();
let socket: WebSocket | null = null;
let lastToolCard: HTMLElement | null = null;
let currentAssistantBubble: HTMLElement | null = null;

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

// ---------- Sign-in screen ----------

function renderSignIn(errorMessage?: string): void {
  app.innerHTML = "";

  const serverInput = el("input", {
    placeholder: "server URL (leave blank for same origin)",
    value: settings.serverUrl,
  });
  const tokenInput = el("input", { type: "password", placeholder: "server token (if required)", value: settings.token });

  const signInBtn = el("button", { className: "primary", textContent: "Continue" });
  const skipBtn = el("button", { className: "secondary", textContent: "Skip sign-in" });

  const form = el(
    "div",
    { className: "setup sign-in" },
    el("h2", { textContent: "CodeJustWrite" }),
    el("p", { textContent: "Sign in to access your repositories." }),
    el("label", {}, "Server URL", serverInput),
    el("label", {}, "Access token", tokenInput),
    ...(errorMessage ? [el("div", { className: "error", textContent: errorMessage })] : []),
    el("div", { className: "btn-row" }, signInBtn, skipBtn)
  );
  app.append(form);

  signInBtn.addEventListener("click", async () => {
    const server = serverInput.value.trim();
    const token = tokenInput.value.trim();
    settings.serverUrl = server;
    settings.token = token;
    saveSettings(settings);

    try {
      const res = await fetch(`${httpBase(settings)}/api/auth/status`, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      renderRepoSelect();
    } catch (err) {
      renderSignIn(err instanceof Error ? err.message : String(err));
    }
  });

  skipBtn.addEventListener("click", () => {
    settings.serverUrl = serverInput.value.trim();
    settings.token = tokenInput.value.trim();
    saveSettings(settings);
    renderRepoSelect();
  });
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

  const browseBtn = el("button", { className: "secondary", textContent: "Browse my repos" });
  const startBtn = el("button", { className: "primary", textContent: "Start session" });
  const signOutBtn = el("button", { className: "text-btn", textContent: "Sign out" });

  const form = el(
    "div",
    { className: "setup repo-select" },
    el("h2", { textContent: "Choose a repository" }),
    el("label", {}, "Repo URL", repoInput),
    browseBtn,
    repoList,
    statusDiv,
    el(
      "div",
      { className: "row" },
      el("label", {}, "Branch", branchInput),
      el("button", { className: "text-btn small", textContent: "Sign out" }, signOutBtn)
    ),
    ...(errorMessage ? [el("div", { className: "error", textContent: errorMessage })] : []),
    startBtn
  );
  app.append(form);

  signOutBtn.addEventListener("click", () => {
    settings.token = "";
    saveSettings(settings);
    renderSignIn();
  });

  browseBtn.addEventListener("click", async () => {
    repoList.innerHTML = "";
    statusDiv.textContent = "Loading repositories…";
    statusDiv.className = "repo-status";

    try {
      const res = await fetch(`${httpBase(settings)}/api/repos`, {
        headers: settings.token ? { authorization: `Bearer ${settings.token}` } : {},
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

      statusDiv.textContent = "";
      const repos = data.repos as { fullName: string; cloneUrl: string; defaultBranch: string; private: boolean }[];
      if (!repos.length) {
        statusDiv.textContent = "No repositories found.";
        return;
      }

      // Add search/filter functionality
      const filterRepos = () => {
        const query = searchInput.value.toLowerCase().trim();
        repoList.innerHTML = "";
        const filtered = query
          ? repos.filter((r) => r.fullName.toLowerCase().includes(query))
          : repos;
        if (!filtered.length) {
          repoList.append(el("div", { className: "repo-status", textContent: query ? "No matching repos." : "No repos found." }));
          return;
        }
        for (const repo of filtered) {
          const item = el(
            "button",
            { className: "repo-item", type: "button" },
            el("span", { className: "name", textContent: repo.fullName }),
            el("span", { className: "meta", textContent: repo.private ? "private" : "public" })
          );
          item.addEventListener("click", () => {
            repoInput.value = repo.cloneUrl;
            branchInput.value = repo.defaultBranch;
            settings.repoUrl = repo.cloneUrl;
            settings.branch = repo.defaultBranch;
            saveSettings(settings);
            // Add to recent
            addRecentRepo(repo);
          });
          repoList.append(item);
        }
      };

      // Add search input above the list
      const searchContainer = el("div", { className: "search-container" }, searchInput);
      form.insertBefore(searchContainer, browseBtn);
      searchInput.addEventListener("input", filterRepos);
      filterRepos();

      // Show recent repos
      const recent = getRecentRepos();
      if (recent.length) {
        recentList.innerHTML = "";
        const header = el("div", { className: "section-header", textContent: "Recent" });
        form.insertBefore(header, searchContainer);
        form.insertBefore(recentList, searchContainer);
        for (const repo of recent) {
          const item = el(
            "button",
            { className: "repo-item", type: "button" },
            el("span", { className: "name", textContent: repo.fullName }),
            el("span", { className: "meta", textContent: repo.private ? "private" : "public" })
          );
          item.addEventListener("click", () => {
            repoInput.value = repo.cloneUrl;
            branchInput.value = repo.defaultBranch;
            settings.repoUrl = repo.cloneUrl;
            settings.branch = repo.defaultBranch;
            saveSettings(settings);
          });
          recentList.append(item);
        }
      }
    } catch (err) {
      statusDiv.textContent = err instanceof Error ? err.message : String(err);
      statusDiv.className = "repo-status error";
    }
  });

  startBtn.addEventListener("click", async () => {
    settings.repoUrl = repoInput.value.trim();
    settings.branch = branchInput.value.trim();
    saveSettings(settings);

    if (!settings.repoUrl) {
      renderRepoSelect("Repo URL is required.");
      return;
    }

    startBtn.textContent = "Cloning…";
    (startBtn as HTMLButtonElement).disabled = true;
    try {
      const res = await fetch(`${httpBase(settings)}/api/sessions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(settings.token ? { authorization: `Bearer ${settings.token}` } : {}),
        },
        body: JSON.stringify({ repoUrl: settings.repoUrl, branch: settings.branch || undefined }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      settings.sessionId = data.sessionId;
      settings.provider = data.provider;
      settings.model = data.model;
      saveSettings(settings);
      connect();
    } catch (err) {
      renderRepoSelect(err instanceof Error ? err.message : String(err));
    }
  });
}

function getRecentRepos(): { fullName: string; cloneUrl: string; defaultBranch: string; private: boolean }[] {
  try {
    const raw = localStorage.getItem("cjw.recent");
    if (!raw) return [];
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function addRecentRepo(repo: { fullName: string; cloneUrl: string; defaultBranch: string; private: boolean }): void {
  try {
    const recent = getRecentRepos().filter((r) => r.fullName !== repo.fullName);
    recent.unshift(repo);
    localStorage.setItem("cjw.recent", JSON.stringify(recent.slice(0, 5)));
  } catch {
    // localStorage unavailable
  }
}

// ---------- Chat screen ----------

function renderChat(): void {
  app.innerHTML = "";

  const messages = el("div", { className: "messages" });
  const sub = el("div", { className: "sub", textContent: `${settings.provider}:${settings.model}` });
  const settingsBtn = el("button", { className: "icon-btn", textContent: "⚙" });
  const topbar = el(
    "div",
    { className: "topbar" },
    el("div", {}, el("h1", { textContent: "CodeJustWrite" }), sub),
    settingsBtn
  );

  const textarea = el("textarea", { rows: 1, placeholder: "Ask the agent to do something…" });
  const sendBtn = el("button", { textContent: "➤" });
  const composer = el("div", { className: "composer" }, textarea, sendBtn);

  app.append(topbar, messages, composer);

  const send = () => {
    const text = textarea.value.trim();
    if (!text || !socket || socket.readyState !== WebSocket.OPEN) return;
    addBubble("user", text);
    socket.send(JSON.stringify({ type: "user_message", text }));
    textarea.value = "";
    currentAssistantBubble = null;
  };

  sendBtn.addEventListener("click", send);
  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
  settingsBtn.addEventListener("click", openDrawer);
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
  const head = el(
    "div",
    { className: "head" },
    el("span", { textContent: `→ ${name}` }),
    el("span", { className: "status", textContent: "running…" })
  );
  const body = el("div", { className: "body", textContent: JSON.stringify(args) });
  const card = el("div", { className: "tool-card" }, head, body);
  document.querySelector(".messages")?.append(card);
  scrollToBottom();
  return card;
}

function addConfirmCard(callId: string, question: string): void {
  const status = el("span", { className: "status", textContent: "awaiting approval" });
  const head = el("div", { className: "head" }, el("span", { textContent: "⚠ confirm" }), status);
  const body = el("div", { className: "body", textContent: question });
  const approve = el("button", { className: "approve", textContent: "Approve" });
  const deny = el("button", { className: "deny", textContent: "Deny" });
  const row = el("div", { className: "confirm-row" }, approve, deny);
  const card = el("div", { className: "tool-card" }, head, body, row);
  document.querySelector(".messages")?.append(card);
  scrollToBottom();

  const decide = (approved: boolean) => {
    socket?.send(JSON.stringify({ type: "tool_decision", callId, approved }));
    status.textContent = approved ? "approved" : "denied";
    row.remove();
  };
  approve.addEventListener("click", () => decide(true));
  deny.addEventListener("click", () => decide(false));
}

// ---------- Settings drawer ----------

function openDrawer(): void {
  const backdrop = el("div", { className: "drawer-backdrop" });
  const autoApproveInput = el("input", { type: "checkbox", checked: settings.autoApprove });
  const providerSelect = el(
    "select",
    {},
    el("option", { value: "openai", textContent: "OpenAI" }),
    el("option", { value: "deepinfra", textContent: "DeepInfra" }),
    el("option", { value: "openrouter", textContent: "OpenRouter" })
  );
  providerSelect.value = settings.provider;
  const modelInput = el("input", { value: settings.model });
  const endBtn = el("button", { className: "danger-btn", textContent: "End session" });

  const drawer = el(
    "div",
    { className: "drawer" },
    el("h2", { textContent: "Settings" }),
    el(
      "div",
      { className: "toggle-row" },
      el("span", { textContent: "Auto-approve all actions" }),
      el(
        "label",
        { className: "switch" },
        autoApproveInput,
        el("span", { className: "slider" })
      )
    ),
    el("label", {}, "Provider", providerSelect),
    el("label", {}, "Model", modelInput),
    el("div", { className: "sub", textContent: `Repo: ${settings.repoUrl}` }),
    endBtn
  );

  backdrop.addEventListener("click", () => {
    backdrop.remove();
    drawer.remove();
  });

  autoApproveInput.addEventListener("change", () => {
    settings.autoApprove = autoApproveInput.checked;
    saveSettings(settings);
    socket?.send(JSON.stringify({ type: "set_auto_approve", value: settings.autoApprove }));
  });
  providerSelect.addEventListener("change", () => {
    settings.provider = providerSelect.value as Settings["provider"];
    saveSettings(settings);
    socket?.send(JSON.stringify({ type: "set_provider", provider: settings.provider }));
  });
  modelInput.addEventListener("change", () => {
    settings.model = modelInput.value.trim();
    saveSettings(settings);
    socket?.send(JSON.stringify({ type: "set_model", model: settings.model }));
  });
  endBtn.addEventListener("click", async () => {
    if (settings.sessionId) {
      await fetch(`${httpBase(settings)}/api/sessions/${settings.sessionId}`, {
        method: "DELETE",
        headers: settings.token ? { authorization: `Bearer ${settings.token}` } : {},
      }).catch(() => {});
    }
    settings.sessionId = "";
    saveSettings(settings);
    socket?.close();
    renderRepoSelect();
  });

  document.body.append(backdrop, drawer);
}

// ---------- WebSocket wiring ----------

function connect(): void {
  renderChat();
  const url = `${wsBase(settings)}/ws?sessionId=${encodeURIComponent(settings.sessionId)}&token=${encodeURIComponent(settings.token)}`;
  socket = new WebSocket(url);

  socket.addEventListener("message", (event) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }

    switch (msg.type) {
      case "state": {
        settings.provider = msg.provider as Settings["provider"];
        settings.model = String(msg.model);
        saveSettings(settings);
        const sub = document.querySelector(".topbar .sub");
        if (sub) sub.textContent = `${settings.provider}:${settings.model}`;
        break;
      }
      case "assistant_delta": {
        if (!currentAssistantBubble) currentAssistantBubble = addBubble("assistant", "");
        currentAssistantBubble.textContent += String(msg.text ?? "");
        scrollToBottom();
        break;
      }
      case "assistant_done": {
        currentAssistantBubble = null;
        break;
      }
      case "tool_call": {
        lastToolCard = addToolCard(String(msg.name), msg.args);
        break;
      }
      case "tool_result": {
        const card = lastToolCard;
        if (card) {
          const status = card.querySelector(".status");
          const body = card.querySelector(".body");
          if (status) {
            status.textContent = msg.error ? "error" : "done";
            status.className = `status ${msg.error ? "err" : "ok"}`;
          }
          if (body) body.textContent += `\n\n${String(msg.result ?? "")}`;
        }
        break;
      }
      case "diff": {
        if (lastToolCard) {
          const body = lastToolCard.querySelector(".body");
          if (body) body.textContent += `\n\n${String(msg.text ?? "")}`;
        }
        break;
      }
      case "awaiting_confirmation": {
        addConfirmCard(String(msg.callId), String(msg.question ?? "Allow this action?"));
        break;
      }
      case "error": {
        addBubble("error", String(msg.message ?? "Unknown error"));
        break;
      }
    }
  });

  socket.addEventListener("close", () => {
    addBubble("system", "Disconnected. Reload to reconnect.");
  });

  socket.addEventListener("error", () => {
    addBubble("error", "Connection error.");
  });
}

// ---------- Boot ----------

if (settings.sessionId) {
  connect();
} else if (settings.token) {
  renderRepoSelect();
} else {
  renderSignIn();
}