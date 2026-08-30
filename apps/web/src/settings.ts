export interface Settings {
  serverUrl: string; // empty = same origin as the page
  token: string;
  repoUrl: string;
  branch: string;
  provider: "openai" | "deepinfra" | "openrouter";
  model: string;
  autoApprove: boolean;
  sessionId: string;
}

const KEY = "cjw.settings";

const defaults: Settings = {
  serverUrl: "",
  token: "",
  repoUrl: "",
  branch: "",
  provider: "openai",
  model: "gpt-4.1",
  autoApprove: false,
  sessionId: "",
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

export function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // localStorage unavailable (private mode, etc.) — settings just won't persist.
  }
}

export function httpBase(settings: Settings): string {
  return settings.serverUrl.replace(/\/$/, "");
}

export function wsBase(settings: Settings): string {
  if (settings.serverUrl) {
    return settings.serverUrl.replace(/^http/, "ws").replace(/\/$/, "");
  }
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}`;
}
