import type { ChatMessage, ServerMessage, Settings } from "./types";
import { debounce, loadSettings, persistSettings } from "./settings";

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
let socket: WebSocket | null = null;
let currentAssistantBubble: HTMLDivElement | null = null;
let settings: Settings = loadSettings();

// --- Helpers ---
function el<T extends HTMLElement>(sel: string): T {
  const e = document.querySelector(sel);
  if (!e) throw new Error(`Element not found: ${sel}`);
  return e as T;
}

function apiBase(s: Settings): string {
  return (s.serverUrl || location.origin).replace(/\/$/, "");
}

function wsBase(s: Settings): string {
  const base = apiBase(s);
  return base.replace(/^http/, "ws");
}

async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const base = apiBase(settings);
  const url = `${base}${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(init.headers as Record<string, string> || {}),
  };
  if (settings.token) headers["Authorization"] = `Bearer ${settings.token}`;
  return fetch(url, { ...init, headers });
}

function show(el: HTMLElement) {
  el.classList.remove("hidden");
}

function hide(el: HTMLElement) {
  el.classList.add("hidden");
}

function text(el: HTMLElement, msg: string) {
  el.textContent = msg;
}

// Validate URL format
function isValidUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

// --- Sign In ---
async function handleSignIn(): Promise<void> {
  const serverUrl = serverInput.value.trim();
  const token = tokenInput.value.trim();
  
  // Validate URL format
  if (serverUrl && !isValidUrl(serverUrl)) {
    text(signInError, "Please enter a valid URL (http:// or https://)");
    show(signInError);
    return;
  }
  
  persistSettings({ serverUrl, token });
  settings = loadSettings();

  try {
    const res = await apiFetch("/api/auth/status");
    if (!res.ok) {
      const err = await res.text().catch(() => "Unknown error");
      throw new Error(err || "Invalid token");
    }
    hide(signInError);
    showRepoSection();
  } catch (e) {
    text(signInError, String(e instanceof Error ? e.message : e));
    show(signInError);
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
    const res = await apiFetch(`/api/github/repos?q=${encodeURIComponent(query)}`);
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

function escapeHtml(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
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
    const res = await apiFetch("/api/session/start", {
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
    recent.unshift({ full_name: repo.replace(/^.*github\.com\//, ""), clone_url: repo, default_branch: branch });
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
  if (socket) {
    try { socket.close(); } catch {}
  }
  
  // Note: Browser WebSocket API doesn't support custom headers
  // Token is passed in query param as fallback (exposed in logs/proxies)
  // Server also accepts Authorization header for non-browser clients
  const wsUrl = `${wsBase(settings)}/ws?sessionId=${encodeURIComponent(sessionId)}&token=${encodeURIComponent(settings.token)}`;
  socket = new WebSocket(wsUrl);
  
  const messageQueue: string[] = [];
  let isOpen = false;

  socket.onopen = () => {
    isOpen = true;
    while (messageQueue.length) {
      const msg = messageQueue.shift();
      if (msg) socket.send(msg);
    }
    typingIndicator.classList.add("hidden");
  };
  
  socket.onmessage = (ev) => {
    try {
      const msg = JSON.parse(String(ev.data)) as ServerMessage;
      handleServerMessage(msg);
    } catch {
      // ignore non-JSON
    }
  };
  
  socket.onerror = () => {
    addBubble("system", "Connection error. Please refresh the page.");
  };
  
  socket.onclose = () => {
    isOpen = false;
    socket = null;
    typingIndicator.classList.add("hidden");
  };

  function send(obj: unknown) {
    const json = JSON.stringify(obj);
    if (isOpen && socket?.readyState === WebSocket.OPEN) {
      socket.send(json);
    } else {
      messageQueue.push(json);
    }
  }

  (window as unknown as { chatSend: (text: string) => void }).chatSend = (text: string) => {
    send({ type: "user_message", text });
  };
}

function handleServerMessage(msg: ServerMessage): void {
  if (msg.type === "assistant_delta") {
    if (!currentAssistantBubble) {
      currentAssistantBubble = addBubble("assistant", "");
    }
    currentAssistantBubble.textContent += String(msg.text ?? "");
    scrollToBottom();
  } else if (msg.type === "assistant_done") {
    currentAssistantBubble = null;
    typingIndicator.classList.add("hidden");
  } else if (msg.type === "tool_start") {
    addBubble("system", `Running ${String(msg.tool)}...`);
    typingIndicator.classList.remove("hidden");
  } else if (msg.type === "error") {
    addBubble("system", `Error: ${String(msg.message)}`);
    typingIndicator.classList.add("hidden");
  } else if (msg.type === "system") {
    addBubble("system", String(msg.text));
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
  const text = chatInput.value.trim();
  if (!text) return;
  addBubble("user", text);
  chatInput.value = "";
  typingIndicator.classList.remove("hidden");
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
    persistSettings({ sessionId: "", token: "", recentRepos: [] });
    settings = loadSettings();
    if (socket) {
      socket.close();
      socket = null;
    }
    show(signInSection);
    hide(repoSection);
    hide(chatSection);
    repoUrlInput.value = "";
    branchInput.value = "";
  });
}

init();
