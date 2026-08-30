import type { Settings } from "./types.js";

const KEY = "cjw.settings";

const defaults: Settings = {
  serverUrl: "",
  token: "",
  repoUrl: "",
  branch: "",
  provider: "openai",
  model: "gpt-4o",
  autoApprove: false,
  sessionId: "",
  recentRepos: [],
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
