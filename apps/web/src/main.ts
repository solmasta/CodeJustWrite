import "./style.css";
import type { ServerMessage, Settings } from "./types.js";
import {
  loadSettings,
  persistSettings,
  loadActiveSession,
  saveActiveSession,
  clearActiveSession,
  loadTranscript,
  appendTranscript,
  updateLastTranscriptEntry,
  clearTranscript,
} from "./settings.js";
import { createConnection } from "./connection.js";
import { el, apiFetch, escapeHtml, isValidUrl, show, hide, text, debounce } from "./utils.js";

// --- DOM refs ---
const signInSection = el<HTMLDivElement>("#signInSection");
const repoSection = el<HTMLDivElement>("#repoSection");
const chatSection = el<HTMLDivElement>("#chatSection");

const serverInput = el<HTMLInputElement>("#serverUrl");
const tokenInput = el<HTMLInputElement>("#token");
const continueBtn = el<HTMLButtonElement>("#continueBtn");
const signInError = el<HTMLParagraphElement>("#signInError");

const repoUrlInput = el<HTMLInputElement>("#repoUrl");
const branchInput = el<HTMLInputElement>("#branch");
const startBtn = el<HTMLButtonElement>("#startBtn");
const browseBtn = el<HTMLButtonElement>("#browseBtn");
const repoError = el<HTMLParagraphElement>("#repoError");

const repoSub = el<HTMLDivElement>("#repoSub");
const chatHistory = el<HTMLDivElement>("#chatHistory");
const chatInput = el<HTMLTextAreaElement>("#chatInput");
const sendBtn = el<HTMLButtonElement>("#sendBtn");
const typingIndicator = el<HTMLDivElement>("#typingIndicator");
const settingsBtn = el<HTMLButtonElement>("#settingsBtn");
const connectionStatus = el<HTMLSpanElement>("#connectionStatus");

const settingsModal = el<HTMLDialogElement>("#settingsModal");
const providerSelect = el<HTMLSelectElement>("#provider");
const modelInput = el<HTMLInputElement>("#model");
const modelSelect = el<HTMLSelectElement>("#modelSelect");
const modelHint = el<HTMLParagraphElement>("#modelHint");
const autoApproveCheck = el<HTMLInputElement>("#autoApprove");
const saveSettingsBtn = el<HTMLButtonElement>("#saveSettings");
const closeSettingsBtn = el<HTMLButtonElement>("#closeSettings");

const signOutBtn = el<HTMLButtonElement>("#signOutBtn");
const changeRepoBtn = el<HTMLButtonElement>("#changeRepoBtn");
const repoList = el<HTMLDivElement>("#repoList");
const repoSearch = el<HTMLInputElement>("#repoSearch");
const recentReposSection = el<HTMLDivElement>("#recentReposSection");
const recentReposList = el<HTMLDivElement>("#recentReposList");

// --- State ---
let connection: ReturnType<typeof createConnection> | null = null;
let currentAssistantBubble: HTMLDivElement | null = null;
let lastToolCard: HTMLDivElement | null = null;
let settings: Settings = loadSettings();
let isProcessing = false;
let currentSessionId: string | null = null;

// --- Sign In ---
async function handleSignIn(): Promise<void> {
  const serverUrl = serverInput.value.trim();
  const token = tokenInput.value.trim();

  if (serverUrl && !isValidUrl(serverUrl)) {
    text(signInError, "Please enter a valid URL (http:// or https://)");
    show(signInError);
    return;
  }

  continueBtn.disabled = true;
  text(signInError, "Connecting…");
  show(signInError);

  try {
    persistSettings({ serverUrl, token });
    settings = loadSettings();
    const res = await apiFetch(settings, "/api/auth/status");
    if (!res.ok) {
      if (res.status === 401) {
        throw new Error(
          token
            ? "Unauthorized — this token doesn't match the server's CJW_AUTH_TOKEN."
            : "Unauthorized — this server requires an access token. Enter the CJW_AUTH_TOKEN you set for it."
        );
      }
      const body = await res.json().catch(() => null);
      throw new Error(body?.error || `Server returned HTTP ${res.status}`);
    }
    hide(signInError);
    await showRepoSection();
  } catch (e) {
    text(signInError, String(e instanceof Error ? e.message : e));
    show(signInError);
  } finally {
    continueBtn.disabled = false;
  }
}

// --- Repo Selection ---
async function showRepoSection(): Promise<void> {
  hide(signInSection);
  show(repoSection);
  loadRecentRepos();
  await loadRepos("");
}

function loadRecentRepos(): void {
  const recent = settings.recentRepos || [];
  if (recent.length === 0) {
    hide(recentReposSection);
    return;
  }
  show(recentReposSection);
  recentReposList.innerHTML = "";
  for (const repo of recent.slice(0, 5)) {
    const item = document.createElement("div");
    item.className = "repo-item recent";
    item.innerHTML = `<span class="repo-name">${escapeHtml(repo.full_name)}</span>`;
    item.onclick = () => {
      repoUrlInput.value = repo.clone_url;
      branchInput.value = repo.default_branch || "main";
    };
    recentReposList.appendChild(item);
  }
}

async function loadRepos(query: string): Promise<void> {
  repoList.innerHTML = "<div class='loading'>Loading repositories…</div>";
  try {
    const res = await apiFetch(settings, `/api/github/repos?q=${encodeURIComponent(query)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to load repositories");
    const repos = data.repos as { full_name: string; clone_url: string; default_branch?: string }[];
    repoList.innerHTML = "";
    if (repos.length === 0) {
      repoList.innerHTML = "<div class='empty'>No repositories found</div>";
      return;
    }
    for (const repo of repos) {
      const item = document.createElement("div");
      item.className = "repo-item";
      item.innerHTML = `<span class="repo-name">${escapeHtml(repo.full_name)}</span>`;
      item.onclick = () => {
        repoUrlInput.value = repo.clone_url;
        branchInput.value = repo.default_branch || "main";
      };
      repoList.appendChild(item);
    }
  } catch (e) {
    repoList.innerHTML = `<div class='error'>${escapeHtml(e instanceof Error ? e.message : String(e))}</div>`;
  }
}

const debouncedLoadRepos = debounce((q: unknown) => void loadRepos(String(q)), 300);

// --- Chat ---
async function startSession(): Promise<void> {
  const repo = repoUrlInput.value.trim();
  const branch = branchInput.value.trim() || "main";
  if (!repo) {
    text(repoError, "Please select or enter a repository URL");
    show(repoError);
    return;
  }
  hide(repoError);
  startBtn.disabled = true;
  startBtn.textContent = "Starting…";

  try {
    const res = await apiFetch(settings, "/api/session/start", {
      method: "POST",
      body: JSON.stringify({ repoUrl: repo, branch }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to start session");
    const sessionId = data.sessionId as string;

    // Save to recent repos
    const recent = settings.recentRepos || [];
    const existingIndex = recent.findIndex((r) => r.clone_url === repo);
    if (existingIndex >= 0) recent.splice(existingIndex, 1);
    const repoName = repo.replace(/^.*github\.com\//, "").replace(/\.git$/, "");
    recent.unshift({ full_name: repoName, clone_url: repo, default_branch: branch });
    persistSettings({ recentRepos: recent.slice(0, 10) });
    settings = loadSettings();
    saveActiveSession({ sessionId, repoName });

    repoSub.textContent = repoName;
    hide(repoSection);
    show(chatSection);
    connectWebSocket(sessionId);
  } catch (e) {
    text(repoError, String(e instanceof Error ? e.message : e));
    show(repoError);
  } finally {
    startBtn.disabled = false;
    startBtn.textContent = "Start Session";
  }
}

async function endSession(): Promise<void> {
  const active = loadActiveSession();
  if (!active) return;
  await apiFetch(settings, `/api/session/${active.sessionId}`, { method: "DELETE" }).catch(() => {});
}

/** Leaves the current session and returns to the repo picker, keeping the sign-in token. */
function backToRepoPicker(): void {
  void endSession();
  connection?.close();
  connection = null;
  if (currentSessionId) clearTranscript(currentSessionId);
  currentSessionId = null;
  clearActiveSession();
  settingsModal.close();
  chatHistory.innerHTML = "";
  hide(chatSection);
  void showRepoSection();
}

function connectWebSocket(sessionId: string): void {
  connection?.close();
  currentSessionId = sessionId;

  connection = createConnection(sessionId, settings, (status) => {
    if (status === "failed") {
      connectionStatus.className = "connection-status disconnected";
      connectionStatus.textContent = "Session lost";
      addBubble(
        "system",
        "Couldn't reconnect to this session — it may no longer exist on the server. " +
          "Open Settings (⚙) → Change Repository to start a new one."
      );
      return;
    }
    connectionStatus.className = `connection-status ${status}`;
    connectionStatus.textContent = status.charAt(0).toUpperCase() + status.slice(1);

    if (status === "connected") {
      typingIndicator.classList.add("hidden");
    } else if (status === "disconnected") {
      addBubble("system", "Connection lost. Attempting to reconnect…");
    }
  });

  connection.onMessage((msg) => handleServerMessage(msg as ServerMessage));
}

function handleServerMessage(msg: ServerMessage): void {
  switch (msg.type) {
    case "state": {
      if (msg.provider) {
        settings.provider = msg.provider as Settings["provider"];
        settings.model = msg.model ?? settings.model;
        persistSettings({ provider: settings.provider, model: settings.model });
      }
      break;
    }
    case "assistant_delta": {
      const isNewBubble = !currentAssistantBubble;
      if (!currentAssistantBubble) currentAssistantBubble = addBubble("assistant", "");
      currentAssistantBubble.textContent += String(msg.text ?? "");
      const fullText = currentAssistantBubble.textContent ?? "";
      if (currentSessionId) {
        if (isNewBubble) appendTranscript(currentSessionId, { kind: "assistant", text: fullText });
        else updateLastTranscriptEntry(currentSessionId, (e) => (e.kind === "assistant" ? { ...e, text: fullText } : e));
      }
      scrollToBottom();
      break;
    }
    case "assistant_done": {
      currentAssistantBubble = null;
      typingIndicator.classList.add("hidden");
      isProcessing = false;
      break;
    }
    case "tool_call": {
      lastToolCard = addToolCard(String(msg.name), msg.args);
      if (currentSessionId) appendTranscript(currentSessionId, { kind: "tool", name: String(msg.name), args: msg.args });
      typingIndicator.classList.remove("hidden");
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
      if (currentSessionId) {
        updateLastTranscriptEntry(currentSessionId, (e) =>
          e.kind === "tool" ? { ...e, result: String(msg.result ?? ""), error: Boolean(msg.error) } : e
        );
      }
      break;
    }
    case "diff": {
      if (lastToolCard) {
        const body = lastToolCard.querySelector(".body");
        if (body) body.textContent += `\n\n${String(msg.text ?? "")}`;
      }
      if (currentSessionId) {
        updateLastTranscriptEntry(currentSessionId, (e) =>
          e.kind === "tool" ? { ...e, result: `${e.result ?? ""}\n\n${String(msg.text ?? "")}` } : e
        );
      }
      break;
    }
    case "awaiting_confirmation": {
      const callId = String(msg.callId);
      const question = String(msg.question ?? "Allow this action?");
      addConfirmCard(callId, question);
      if (currentSessionId) appendTranscript(currentSessionId, { kind: "confirm", callId, question });
      break;
    }
    case "error": {
      // A failed list_models request (e.g. the provider's key isn't configured, or its /models
      // endpoint errored or timed out) rejects with a plain "error" message, same as any other
      // server-side failure — with no fix, it'd only ever show up as a chat bubble the user might
      // not even scroll back to, while Settings stayed stuck on "Loading available models…"
      // forever with no visible explanation right where they were actually looking.
      if (modelsRequestedFor) {
        text(modelHint, `Couldn't load models: ${String(msg.message ?? "unknown error")}`);
        modelSelect.innerHTML = '<option value="">(failed to load — type a model id manually)</option>';
        modelsRequestedFor = null;
      }
      const errorText = `Error: ${String(msg.message ?? "Unknown error")}`;
      addBubble("system", errorText);
      if (currentSessionId) appendTranscript(currentSessionId, { kind: "system", text: errorText });
      typingIndicator.classList.add("hidden");
      isProcessing = false;
      break;
    }
    case "models": {
      const provider = String((msg as { provider?: string }).provider ?? "");
      // Ignore a response to a provider the picker has since moved away from.
      if (provider !== modelsRequestedFor || provider !== providerSelect.value) break;
      const models = msg.models ?? [];
      modelSelect.innerHTML = "";
      const placeholder = document.createElement("option");
      placeholder.value = "";
      placeholder.textContent = models.length ? "— pick a model —" : "No models found";
      modelSelect.appendChild(placeholder);
      for (const m of models) {
        const option = document.createElement("option");
        option.value = m.id;
        option.textContent = m.id;
        modelSelect.appendChild(option);
      }
      text(
        modelHint,
        models.length
          ? `${models.length} models available for ${provider} — pick one below, or type any model id above.`
          : `Couldn't load the model list for ${provider}. Type a model id manually.`
      );
      break;
    }
  }
}

function addBubble(role: "user" | "assistant" | "system", content: string): HTMLDivElement {
  const div = document.createElement("div");
  div.className = `bubble ${role}`;
  div.textContent = content;
  chatHistory.appendChild(div);
  scrollToBottom();
  return div;
}

function addToolCard(name: string, args: unknown): HTMLDivElement {
  const card = document.createElement("div");
  card.className = "tool-card";
  card.innerHTML = `
    <div class="head"><span>→ ${escapeHtml(name)}</span><span class="status">running…</span></div>
    <div class="body">${escapeHtml(JSON.stringify(args))}</div>
  `;
  chatHistory.appendChild(card);
  scrollToBottom();
  return card;
}

function addConfirmCard(callId: string, question: string): void {
  const card = document.createElement("div");
  card.className = "tool-card";
  card.innerHTML = `
    <div class="head"><span>⚠ confirm</span><span class="status">awaiting approval</span></div>
    <div class="body">${escapeHtml(question)}</div>
    <div class="confirm-row">
      <button type="button" class="approve">Approve</button>
      <button type="button" class="deny">Deny</button>
    </div>
  `;
  chatHistory.appendChild(card);
  scrollToBottom();

  const status = card.querySelector(".status") as HTMLElement;
  const row = card.querySelector(".confirm-row") as HTMLElement;
  const decide = (approved: boolean) => {
    connection?.send({ type: "tool_decision", callId, approved });
    status.textContent = approved ? "approved" : "denied";
    row.remove();
    if (currentSessionId) {
      updateLastTranscriptEntry(currentSessionId, (e) =>
        e.kind === "confirm" && e.callId === callId ? { ...e, decided: approved ? "approved" : "denied" } : e
      );
    }
  };
  card.querySelector(".approve")?.addEventListener("click", () => decide(true));
  card.querySelector(".deny")?.addEventListener("click", () => decide(false));
}

function scrollToBottom(): void {
  chatHistory.scrollTop = chatHistory.scrollHeight;
}

function sendChat(): void {
  if (isProcessing) return;
  const message = chatInput.value.trim();
  if (!message) return;
  addBubble("user", message);
  if (currentSessionId) appendTranscript(currentSessionId, { kind: "user", text: message });
  chatInput.value = "";
  typingIndicator.classList.remove("hidden");
  isProcessing = true;
  connection?.send({ type: "user_message", text: message });
}

/** Recreates the visible chat from a session's persisted transcript — used on load, before the
 *  WebSocket (re)connects, so a page refresh restores what was on screen instead of a blank chat. */
function replayTranscript(sessionId: string): void {
  for (const entry of loadTranscript(sessionId)) {
    switch (entry.kind) {
      case "user":
      case "assistant":
      case "system":
        addBubble(entry.kind, entry.text);
        break;
      case "tool": {
        const card = addToolCard(entry.name, entry.args);
        if (entry.result !== undefined) {
          const status = card.querySelector(".status");
          const body = card.querySelector(".body");
          if (status) {
            status.textContent = entry.error ? "error" : "done";
            status.className = `status ${entry.error ? "err" : "ok"}`;
          }
          if (body) body.textContent += `\n\n${entry.result}`;
        }
        break;
      }
      case "confirm": {
        if (entry.decided) {
          // Already resolved before the refresh — a plain note, not a reconstructed
          // interactive card: nothing is actually left to decide, and re-wiring a stale
          // callId to fresh approve/deny buttons would be misleading.
          addBubble("system", `${entry.decided === "approved" ? "✓ Approved" : "✗ Denied"}: ${entry.question}`);
        } else {
          addConfirmCard(entry.callId, entry.question);
        }
        break;
      }
    }
  }
}

// --- Settings Modal ---
let modelsRequestedFor: string | null = null;

function openSettings(): void {
  providerSelect.value = settings.provider || "deepinfra";
  modelInput.value = settings.model || "";
  autoApproveCheck.checked = settings.autoApprove ?? false;
  settingsModal.showModal();
  refreshModels();
}

function closeSettings(): void {
  settingsModal.close();
}

/** Fetches the live model catalog for whichever provider is currently selected in the dropdown,
 *  so the model field's suggestions reflect what that provider actually offers right now (Claude
 *  models included, for OpenRouter) instead of a value someone has to already know and type. */
function refreshModels(): void {
  if (!connection) return;
  const provider = providerSelect.value;
  modelsRequestedFor = provider;
  modelSelect.innerHTML = '<option value="">Loading…</option>';
  text(modelHint, "Loading available models…");
  show(modelHint);
  connection.send({ type: "list_models", provider });
}

function saveSettings(): void {
  const previousProvider = settings.provider;
  const provider = providerSelect.value as Settings["provider"];
  const model = modelInput.value;
  const autoApprove = autoApproveCheck.checked;

  persistSettings({ provider, model, autoApprove });
  settings = loadSettings();

  if (connection) {
    if (provider !== previousProvider) connection.send({ type: "set_provider", provider });
    connection.send({ type: "set_model", model });
    connection.send({ type: "set_auto_approve", value: autoApprove });
  }
  settingsModal.close();
}

// --- Init ---
function init(): void {
  serverInput.value = settings.serverUrl || "";
  tokenInput.value = settings.token || "";

  const active = loadActiveSession();
  if (active) {
    show(chatSection);
    hide(signInSection);
    hide(repoSection);
    repoSub.textContent = active.repoName;
    replayTranscript(active.sessionId);
    connectWebSocket(active.sessionId);
  } else if (settings.token) {
    void showRepoSection();
    hide(signInSection);
  } else {
    show(signInSection);
    hide(repoSection);
    hide(chatSection);
  }

  continueBtn.addEventListener("click", () => void handleSignIn());
  serverInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void handleSignIn();
  });
  tokenInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void handleSignIn();
  });

  startBtn.addEventListener("click", () => void startSession());
  repoSearch.addEventListener("input", (e) => {
    debouncedLoadRepos((e.target as HTMLInputElement).value);
  });
  browseBtn.addEventListener("click", () => void loadRepos(repoSearch.value));

  sendBtn.addEventListener("click", sendChat);
  chatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendChat();
    }
  });

  settingsBtn.addEventListener("click", openSettings);
  saveSettingsBtn.addEventListener("click", saveSettings);
  closeSettingsBtn.addEventListener("click", closeSettings);
  providerSelect.addEventListener("change", refreshModels);
  modelSelect.addEventListener("change", () => {
    if (!modelSelect.value) return;
    modelInput.value = modelSelect.value;
    modelSelect.selectedIndex = 0; // one-shot picker — the text input above is the source of truth
  });
  settingsModal.addEventListener("click", (e) => {
    if (e.target === settingsModal) closeSettings();
  });

  changeRepoBtn.addEventListener("click", backToRepoPicker);

  signOutBtn.addEventListener("click", () => {
    void endSession();
    connection?.close();
    connection = null;
    if (currentSessionId) clearTranscript(currentSessionId);
    currentSessionId = null;
    clearActiveSession();
    persistSettings({ token: "", recentRepos: [] });
    settings = loadSettings();
    settingsModal.close();
    show(signInSection);
    hide(repoSection);
    hide(chatSection);
    repoUrlInput.value = "";
    branchInput.value = "";
    chatHistory.innerHTML = "";
  });
}

init();
