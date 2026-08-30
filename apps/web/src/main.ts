import type { ServerMessage, Settings } from "./types";
import { loadSettings, persistSettings } from "./settings";
import { createConnection } from "./connection";
import {
  el,
  apiFetch,
  escapeHtml,
  isValidUrl,
  show,
  hide,
  text,
  debounce,
  formatDuration,
} from "./utils";

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

const chatHistory = el<HTMLDivElement>("#chatHistory");
const chatInput = el<HTMLInputElement>("#chatInput");
const sendBtn = el<HTMLButtonElement>("#sendBtn");
const typingIndicator = el<HTMLDivElement>("#typingIndicator");
const settingsBtn = el<HTMLButtonElement>("#settingsBtn");
const connectionStatus = el<HTMLDivElement>("#connectionStatus");

const settingsModal = el<HTMLDialogElement>("#settingsModal");
const providerSelect = el<HTMLSelectElement>("#provider");
const modelInput = el<HTMLInputElement>("#model");
const apiKeyInput = el<HTMLInputElement>("#apiKey");
const autoApproveCheck = el<HTMLInputElement>("#autoApprove");
const saveSettingsBtn = el<HTMLButtonElement>("#saveSettings");
const closeSettingsBtn = el<HTMLButtonElement>("#closeSettings");

const signOutBtn = el<HTMLButtonElement>("#signOutBtn");
const repoList = el<HTMLDivElement>("#repoList");
const repoSearch = el<HTMLInputElement>("#repoSearch");
const recentReposSection = el<HTMLDivElement>("#recentReposSection");
const recentReposList = el<HTMLDivElement>("#recentReposList");

// --- State ---
let connection: ReturnType<typeof createConnection> | null = null;
let currentAssistantBubble: HTMLDivElement | null = null;
let settings: Settings = loadSettings();
let isProcessing = false;

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
  text(signInError, "Connecting...");
  show(signInError);
  
  try {
    const res = await apiFetch(settings, "/api/auth/status");
    if (!res.ok) {
      const err = await res.text().catch(() => "Unknown error");
      throw new Error(err || "Invalid token");
    }
    persistSettings({ serverUrl, token });
    settings = loadSettings();
    hide(signInError);
    showRepoSection();
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
  await loadRecentRepos();
  await loadRepos("");
}

async function loadRecentRepos(): Promise<void> {
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
  repoList.innerHTML = "<div class='loading'>Loading repositories...</div>";
  try {
    const res = await apiFetch(settings, `/api/github/repos?q=${encodeURIComponent(query)}`);
    if (!res.ok) throw new Error("Failed to load repositories");
    const repos = await res.json() as Array<{ full_name: string; clone_url: string; default_branch?: string }>;
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
    repoList.innerHTML = `<div class='error'>${escapeHtml(String(e))}</div>`;
  }
}

const debouncedLoadRepos = debounce((q: string) => loadRepos(q), 300);

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
  startBtn.textContent = "Starting...";

  try {
    const res = await apiFetch(settings, "/api/session/start", {
      method: "POST",
      body: JSON.stringify({ repoUrl: repo, branch }),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(err || "Failed to start session");
    }
    const { sessionId } = await res.json() as { sessionId: string };
    persistSettings({ sessionId });
    settings = loadSettings();

    // Save to recent repos
    const recent = settings.recentRepos || [];
    const existingIndex = recent.findIndex(r => r.clone_url === repo);
    if (existingIndex >= 0) recent.splice(existingIndex, 1);
    recent.unshift({ 
      full_name: repo.replace(/^.*github\.com\//, ""), 
      clone_url: repo, 
      default_branch: branch 
    });
    persistSettings({ recentRepos: recent.slice(0, 10) });

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

function connectWebSocket(sessionId: string): void {
  connection?.close();
  
  connection = createConnection(sessionId, settings, (status) => {
    connectionStatus.className = `connection-status ${status}`;
    connectionStatus.textContent = status.charAt(0).toUpperCase() + status.slice(1);
    
    if (status === "connected") {
      typingIndicator.classList.add("hidden");
    } else if (status === "disconnected") {
      addBubble("system", "Connection lost. Attempting to reconnect...");
    }
  });
  
  connection.onMessage((msg) => handleServerMessage(msg as ServerMessage));
  connection.onOpen(() => {
    // Clear any reconnection messages
  });
  connection.onClose(() => {
    typingIndicator.classList.add("hidden");
    isProcessing = false;
  });
  
  (window as unknown as { chatSend: (text: string) => void }).chatSend = (text: string) => {
    connection?.send({ type: "user_message", text });
  };
}

function handleServerMessage(msg: ServerMessage): void {
  switch (msg.type) {
    case "assistant_delta": {
      if (!currentAssistantBubble) {
        currentAssistantBubble = addBubble("assistant", "");
      }
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
    case "tool_start": {
      addBubble("system", `Running ${String(msg.tool)}...`);
      typingIndicator.classList.remove("hidden");
      break;
    }
    case "error": {
      addBubble("system", `Error: ${String(msg.message)}`);
      typingIndicator.classList.add("hidden");
      isProcessing = false;
      break;
    }
    case "system": {
      addBubble("system", String(msg.text));
      break;
    }
    case "state": {
      // Handle state updates
      break;
    }
  }
}

function addBubble(role: "user" | "assistant" | "system", text: string): HTMLDivElement {
  const div = document.createElement("div");
  div.className = `bubble ${role}`;
  div.textContent = text;
  chatHistory.appendChild(div);
  scrollToBottom();
  return div;
}

function scrollToBottom(): void {
  chatHistory.scrollTop = chatHistory.scrollHeight;
}

function sendChat(): void {
  if (isProcessing) return;
  const text = chatInput.value.trim();
  if (!text) return;
  addBubble("user", text);
  chatInput.value = "";
  typingIndicator.classList.remove("hidden");
  isProcessing = true;
  const sender = (window as unknown as { chatSend?: (text: string) => void }).chatSend;
  if (sender) sender(text);
}

// --- Settings Modal ---
function openSettings(): void {
  providerSelect.value = settings.provider || "openai";
  modelInput.value = settings.model || "";
  apiKeyInput.value = settings.apiKey || "";
  autoApproveCheck.checked = settings.autoApprove ?? false;
  settingsModal.showModal();
}

function closeSettings(): void {
  settingsModal.close();
}

function saveSettings(): void {
  persistSettings({
    provider: providerSelect.value as Settings["provider"],
    model: modelInput.value,
    apiKey: apiKeyInput.value,
    autoApprove: autoApproveCheck.checked,
  });
  settings = loadSettings();
  settingsModal.close();
}

// --- Init ---
function init(): void {
  // Load saved settings
  serverInput.value = settings.serverUrl || "";
  tokenInput.value = settings.token || "";

  // If already has session, go to chat
  if (settings.sessionId) {
    show(chatSection);
    hide(signInSection);
    hide(repoSection);
    connectWebSocket(settings.sessionId);
  } else if (settings.token) {
    showRepoSection();
    hide(signInSection);
  } else {
    show(signInSection);
    hide(repoSection);
    hide(chatSection);
  }

  // Event listeners
  continueBtn.addEventListener("click", handleSignIn);
  serverInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") handleSignIn();
  });
  tokenInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") handleSignIn();
  });
  
  startBtn.addEventListener("click", startSession);
  repoSearch.addEventListener("input", (e) => {
    const target = e.target as HTMLInputElement;
    debouncedLoadRepos(target.value);
  });
  browseBtn.addEventListener("click", () => show(repoSection));
  
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
  settingsModal.addEventListener("click", (e) => {
    if (e.target === settingsModal) closeSettings();
  });
  
  signOutBtn.addEventListener("click", () => {
    connection?.close();
    connection = null;
    persistSettings({ sessionId: "", token: "", recentRepos: [] });
    settings = loadSettings();
    show(signInSection);
    hide(repoSection);
    hide(chatSection);
    repoUrlInput.value = "";
    branchInput.value = "";
    chatHistory.innerHTML = "";
  });
}

init();
