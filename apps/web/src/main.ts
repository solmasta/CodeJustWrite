import "./style.css";
import type { ServerMessage, Settings, PromptPreset } from "./types.js";
import { loadSettings, persistSettings, loadActiveSession, saveActiveSession, clearActiveSession } from "./settings.js";
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

const confirmModal = el<HTMLDialogElement>("#confirmModal");
const confirmQuestion = el<HTMLParagraphElement>("#confirmQuestion");
const confirmApproveBtn = el<HTMLButtonElement>("#confirmApproveBtn");
const confirmDenyBtn = el<HTMLButtonElement>("#confirmDenyBtn");

const settingsModal = el<HTMLDialogElement>("#settingsModal");
const providerSelect = el<HTMLSelectElement>("#provider");
const modelSelect = el<HTMLSelectElement>("#modelSelect");
const modelHint = el<HTMLParagraphElement>("#modelHint");
const promptPresetSelect = el<HTMLSelectElement>("#promptPreset");
const promptPresetHint = el<HTMLParagraphElement>("#promptPresetHint");
const customInstructionsInput = el<HTMLTextAreaElement>("#customInstructions");
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
let settings: Settings = loadSettings();
let isProcessing = false;
let promptPresets: PromptPreset[] = [];

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
  clearActiveSession();
  settingsModal.close();
  chatHistory.innerHTML = "";
  hide(chatSection);
  void showRepoSection();
}

function connectWebSocket(sessionId: string): void {
  connection?.close();

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
      if (msg.promptPresets?.length) {
        promptPresets = msg.promptPresets;
        populatePromptPresetSelect();
      }
      if (msg.promptPreset) {
        settings.promptPreset = msg.promptPreset;
        settings.customInstructions = msg.customInstructions ?? settings.customInstructions;
        persistSettings({ promptPreset: settings.promptPreset, customInstructions: settings.customInstructions });
      }
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
      typingIndicator.classList.add("hidden");
      isProcessing = false;
      break;
    }
    case "tool_call": {
      addToolCallLine(String(msg.name), msg.args);
      typingIndicator.classList.remove("hidden");
      break;
    }
    case "tool_result": {
      addToolResultLine(String(msg.name ?? ""), String(msg.result ?? ""), !!msg.error);
      break;
    }
    case "diff": {
      addLogLine("call", "⎿", "", String(msg.text ?? ""));
      break;
    }
    case "awaiting_confirmation": {
      showConfirmModal(String(msg.question ?? "Allow this tool to run?"), String(msg.callId));
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
        const current = settings.provider === modelsRequestedFor ? settings.model : "";
        modelSelect.innerHTML = current
          ? `<option value="${escapeHtml(current)}" selected>${escapeHtml(current)} (current)</option>`
          : '<option value="">(no models available)</option>';
        modelsRequestedFor = null;
      }
      addBubble("system", `Error: ${String(msg.message ?? "Unknown error")}`);
      typingIndicator.classList.add("hidden");
      isProcessing = false;
      break;
    }
    case "models": {
      const provider = String((msg as { provider?: string }).provider ?? "");
      // Ignore a response to a provider the picker has since moved away from.
      if (provider !== modelsRequestedFor || provider !== providerSelect.value) break;
      const models = msg.models ?? [];
      const current = settings.provider === provider ? settings.model : "";
      modelSelect.innerHTML = "";
      if (!models.length) {
        const placeholder = document.createElement("option");
        placeholder.value = "";
        placeholder.textContent = "No models found";
        modelSelect.appendChild(placeholder);
      }
      let currentIncluded = false;
      for (const m of models) {
        const option = document.createElement("option");
        option.value = m.id;
        option.textContent = m.id;
        if (m.id === current) {
          option.selected = true;
          currentIncluded = true;
        }
        modelSelect.appendChild(option);
      }
      // The saved model may no longer be in the provider's live catalog (e.g. deprecated) —
      // keep it selectable rather than silently swapping it for whatever sorts first.
      if (current && !currentIncluded) {
        const option = document.createElement("option");
        option.value = current;
        option.textContent = `${current} (current)`;
        option.selected = true;
        modelSelect.insertBefore(option, modelSelect.firstChild);
      }
      text(
        modelHint,
        models.length
          ? `${models.length} models available for ${provider}.`
          : `Couldn't load the model list for ${provider}.`
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

/** Picks one argument to show inline next to the tool name, the way Claude Code's own terminal
 *  UI shows e.g. "Write(file.ts)" instead of the tool's full raw argument JSON — the latter used
 *  to dump an entire file's contents into the chat feed for write_file/edit_file, which is what
 *  buried the approve/deny buttons under a wall of text on any non-trivial change. */
function primaryArgSummary(args: Record<string, unknown>): string {
  const preferredKeys = ["path", "pattern", "command", "url", "branch", "title", "message", "script", "pullNumber"];
  for (const key of preferredKeys) {
    const value = args[key];
    if (value === undefined || value === null || value === "") continue;
    const s = String(value);
    return s.length > 60 ? s.slice(0, 57) + "…" : s;
  }
  return "";
}

/** Every tool_call/tool_result/diff event appends its own independent line to the chat feed and
 *  is never looked up or mutated afterward (only a line's own click-to-expand toggle touches it
 *  again) — unlike the old per-tool "card" that stayed around to be updated by a later event
 *  keyed on callId, an append-only log has no stale-reference class of bug to have in the first
 *  place: there's nothing to correlate. */
function addToolLine(cls: string, icon: string, text: string): HTMLDivElement {
  const line = document.createElement("div");
  line.className = `tool-line ${cls}`;
  const iconEl = document.createElement("span");
  iconEl.className = "tl-icon";
  iconEl.textContent = icon;
  const textEl = document.createElement("span");
  textEl.className = "tl-text";
  textEl.textContent = text;
  line.append(iconEl, textEl);
  chatHistory.appendChild(line);
  scrollToBottom();
  return line;
}

function toolLinePreview(body: string, limit = 200): string {
  const oneLine = body.replace(/\s+/g, " ").trim();
  return oneLine.length > limit ? oneLine.slice(0, limit - 1) + "…" : oneLine;
}

/** Appends one line summarizing a tool's output (a result or a diff/log message). Long bodies
 *  collapse to a single-line preview with a click-to-expand toggle, entirely local to that line
 *  — no other line or event ever needs to touch it again. */
function addLogLine(cls: string, icon: string, prefix: string, body: string): void {
  const bodyText = body.trim();
  const preview = toolLinePreview(bodyText);
  const shortText = prefix ? `${prefix}: ${preview || "(empty)"}` : preview || "(empty)";
  const fullText = prefix ? `${prefix}: ${bodyText}` : bodyText;
  const line = addToolLine(cls, icon, shortText);
  if (bodyText.length > preview.length) {
    line.classList.add("clickable");
    const textEl = line.querySelector(".tl-text") as HTMLElement;
    let expanded = false;
    line.addEventListener("click", () => {
      expanded = !expanded;
      line.classList.toggle("expanded", expanded);
      textEl.textContent = expanded ? fullText : shortText;
    });
  }
}

function addToolCallLine(name: string, args: unknown): void {
  const argsObj = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  const summary = primaryArgSummary(argsObj);
  addToolLine("call", "→", `${name}${summary ? `(${summary})` : ""}…`);
}

function addToolResultLine(name: string, result: string, error: boolean): void {
  addLogLine(error ? "err" : "ok", error ? "✗" : "✓", name, result || (error ? "failed" : "done"));
}

/** A single reusable popup for whichever tool is currently awaiting approval — confirmation-
 *  requiring tools never run concurrently (see Agent.executeToolCalls), so there's always at
 *  most one question pending and one popup is always enough. Dismissing it any way other than an
 *  explicit choice (Escape, tapping the backdrop) counts as a deny, so the agent is never left
 *  waiting on a decision that will never come. */
function showConfirmModal(question: string, callId: string): void {
  text(confirmQuestion, question);
  let decided = false;
  const decide = (approved: boolean) => {
    if (decided) return;
    decided = true;
    connection?.send({ type: "tool_decision", callId, approved });
    addToolLine(approved ? "ok" : "err", approved ? "✓" : "✗", approved ? "Approved" : "Denied");
  };
  const onApprove = () => {
    decide(true);
    confirmModal.close();
  };
  const onDeny = () => {
    decide(false);
    confirmModal.close();
  };
  confirmApproveBtn.addEventListener("click", onApprove, { once: true });
  confirmDenyBtn.addEventListener("click", onDeny, { once: true });
  confirmModal.addEventListener("close", () => decide(false), { once: true });
  confirmModal.showModal();
}

function scrollToBottom(): void {
  chatHistory.scrollTop = chatHistory.scrollHeight;
}

function sendChat(): void {
  if (isProcessing) return;
  const message = chatInput.value.trim();
  if (!message) return;
  addBubble("user", message);
  chatInput.value = "";
  typingIndicator.classList.remove("hidden");
  isProcessing = true;
  connection?.send({ type: "user_message", text: message });
}

// --- Settings Modal ---
let modelsRequestedFor: string | null = null;

function openSettings(): void {
  providerSelect.value = settings.provider || "deepinfra";
  autoApproveCheck.checked = settings.autoApprove ?? false;
  populatePromptPresetSelect();
  customInstructionsInput.value = settings.customInstructions || "";
  settingsModal.showModal();
  refreshModels();
}

/** Populates the "Prompt style" dropdown from whichever preset list the server sent in its
 *  "state" message (core's PROMPT_PRESETS, so this stays in sync without hardcoding a copy
 *  here) — falls back to just "Default" if that hasn't arrived yet. */
function populatePromptPresetSelect(): void {
  const current = settings.promptPreset || "default";
  const options = promptPresets.length
    ? promptPresets
    : [{ id: "default", label: "Default", description: "", instructions: "" }];
  promptPresetSelect.innerHTML = "";
  for (const preset of options) {
    const option = document.createElement("option");
    option.value = preset.id;
    option.textContent = preset.label;
    if (preset.id === current) option.selected = true;
    promptPresetSelect.appendChild(option);
  }
  updatePromptPresetHint();
}

function updatePromptPresetHint(): void {
  const preset = promptPresets.find((p) => p.id === promptPresetSelect.value);
  text(promptPresetHint, preset?.description ?? "");
}

function closeSettings(): void {
  settingsModal.close();
}

/** Fetches the live model catalog for whichever provider is currently selected in the dropdown,
 *  so the model list reflects what that provider actually offers right now (Claude models
 *  included, for OpenRouter) instead of a value someone has to already know and type — this also
 *  keeps a deprecated/renamed model from lingering unnoticed as a hand-typed string. */
function refreshModels(): void {
  if (!connection) return;
  const provider = providerSelect.value;
  modelsRequestedFor = provider;
  const current = settings.provider === provider ? settings.model : "";
  modelSelect.innerHTML = current
    ? `<option value="${escapeHtml(current)}" selected>${escapeHtml(current)} (current)</option>`
    : '<option value="">Loading…</option>';
  text(modelHint, "Loading available models…");
  show(modelHint);
  connection.send({ type: "list_models", provider });
}

function saveSettings(): void {
  const previousProvider = settings.provider;
  const provider = providerSelect.value as Settings["provider"];
  const model = modelSelect.value || settings.model;
  const autoApprove = autoApproveCheck.checked;
  const promptPreset = promptPresetSelect.value || settings.promptPreset;
  const customInstructions = customInstructionsInput.value;

  persistSettings({ provider, model, autoApprove, promptPreset, customInstructions });
  settings = loadSettings();

  if (connection) {
    if (provider !== previousProvider) connection.send({ type: "set_provider", provider });
    connection.send({ type: "set_model", model });
    connection.send({ type: "set_auto_approve", value: autoApprove });
    connection.send({ type: "set_prompt_mode", promptPreset, customInstructions });
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
  promptPresetSelect.addEventListener("change", updatePromptPresetHint);
  settingsModal.addEventListener("click", (e) => {
    if (e.target === settingsModal) closeSettings();
  });
  confirmModal.addEventListener("click", (e) => {
    if (e.target === confirmModal) confirmModal.close();
  });

  changeRepoBtn.addEventListener("click", backToRepoPicker);

  signOutBtn.addEventListener("click", () => {
    void endSession();
    connection?.close();
    connection = null;
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
