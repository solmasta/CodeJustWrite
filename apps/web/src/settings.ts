import type { ActiveSession, Settings, TranscriptEntry } from "./types.js";

const KEY = "cjw.settings";
const SESSION_KEY = "cjw.activeSession";
const TRANSCRIPT_KEY_PREFIX = "cjw.transcript.";
const MAX_TRANSCRIPT_ENTRIES = 300;
const DRAFT_KEY = "cjw.draft";

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
    // localStorage unavailable
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
    // sessionStorage unavailable
  }
}

export function clearActiveSession(): void {
  try {
    sessionStorage.removeItem(SESSION_KEY);
  } catch {
    // no-op
  }
}

/**
 * Chat transcript, kept per-session (same tab-scoped sessionStorage as ActiveSession above).
 */
export function loadTranscript(sessionId: string): TranscriptEntry[] {
  try {
    const raw = sessionStorage.getItem(TRANSCRIPT_KEY_PREFIX + sessionId);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveTranscript(sessionId: string, entries: TranscriptEntry[]): void {
  try {
    const trimmed =
      entries.length > MAX_TRANSCRIPT_ENTRIES
        ? entries.slice(-MAX_TRANSCRIPT_ENTRIES)
        : entries;

    sessionStorage.setItem(
      TRANSCRIPT_KEY_PREFIX + sessionId,
      JSON.stringify(trimmed)
    );
  } catch {
    // sessionStorage unavailable or full
  }
}

export function appendTranscript(
  sessionId: string,
  entry: TranscriptEntry
): void {
  const current = loadTranscript(sessionId);
  current.push(entry);
  saveTranscript(sessionId, current);
}

/** Mutates the most recently appended entry. */
export function updateLastTranscriptEntry(
  sessionId: string,
  updater: (entry: TranscriptEntry) => TranscriptEntry
): void {
  const current = loadTranscript(sessionId);
  if (!current.length) return;
  current[current.length - 1] = updater(current[current.length - 1]);
  saveTranscript(sessionId, current);
}

export function clearTranscript(sessionId: string): void {
  try {
    sessionStorage.removeItem(TRANSCRIPT_KEY_PREFIX + sessionId);
  } catch {
    // no-op
  }
}

/** Draft text kept per tab. */
export function loadDraft(): string {
  try {
    return sessionStorage.getItem(DRAFT_KEY) ?? "";
  } catch {
    return "";
  }
}

export function saveDraft(text: string): void {
  try {
    if (text) {
      sessionStorage.setItem(DRAFT_KEY, text);
    } else {
      sessionStorage.removeItem(DRAFT_KEY);
    }
  } catch {
    // sessionStorage unavailable
  }
}

export function clearDraft(): void {
  try {
    sessionStorage.removeItem(DRAFT_KEY);
  } catch {
    // no-op
  }
}
