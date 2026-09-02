import type { ActiveSession, Settings } from "./types.js";

const KEY = "cjw.settings";
const SESSION_KEY = "cjw.activeSession";

const defaults: Settings = {
  serverUrl: "",
  token: "",
  repoUrl: "",
  branch: "",
  provider: "deepinfra",
  model: "moonshotai/Kimi-K3",
  autoApprove: false,
  recentRepos: [],
  promptPreset: "default",
  customInstructions: "",
};

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...defaults };
    return { ...defaults, ...JSON.parse(raw) };
  } catch {
    return { ...defaults };
  }
}

export function persistSettings(partial: Partial<Settings>): void {
  try {
    const current = loadSettings();
    const updated = { ...current, ...partial };
    localStorage.setItem(KEY, JSON.stringify(updated));
  } catch {
    // localStorage unavailable (private mode, etc.) — settings just won't persist.
  }
}

/** Tab-scoped: each browser tab can be connected to a different session. */
export function loadActiveSession(): ActiveSession | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function saveActiveSession(session: ActiveSession): void {
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch {
    // sessionStorage unavailable — the tab just won't survive a reload mid-session.
  }
}

export function clearActiveSession(): void {
  try {
    sessionStorage.removeItem(SESSION_KEY);
  } catch {
    // no-op
  }
}
