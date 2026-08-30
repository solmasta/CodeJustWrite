export interface RepoInfo {
  full_name: string;
  clone_url: string;
  default_branch?: string;
}

export interface Settings {
  serverUrl: string;
  token: string;
  repoUrl: string;
  branch: string;
  provider: "openai" | "deepinfra" | "openrouter";
  model: string;
  autoApprove: boolean;
  sessionId: string;
  recentRepos: RepoInfo[];
}

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

export function debounce<T extends (...args: unknown[]) => void>(
  fn: T,
  delay: number
): (...args: Parameters<T>) => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return (...args: Parameters<T>) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

export function httpBase(settings: Settings): string {
  return (settings.serverUrl || location.origin).replace(/\/$/, "");
}

export function wsBase(settings: Settings): string {
  const base = httpBase(settings);
  return base.replace(/^http/, "ws");
}
