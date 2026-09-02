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

/**
 * Chat transcript, kept per-session (same tab-scoped sessionStorage as ActiveSession above) so
 * reconnecting to the same session after a reload restores what was on screen. Capped at
 * MAX_TRANSCRIPT_ENTRIES so a very long conversation can't grow sessionStorage without bound —
 * old entries are dropped from the front, matching what streams off the top of the visible chat
 * anyway.
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
    const trimmed = entries.length > MAX_TRANSCRIPT_ENTRIES ? entries.slice(-MAX_TRANSCRIPT_ENTRIES) : entries;
    sessionStorage.setItem(TRANSCRIPT_KEY_PREFIX + sessionId, JSON.stringify(trimmed));
  } catch {
    // sessionStorage unavailable or full — the transcript just won't survive a reload.
  }
}

export function appendTranscript(sessionId: string, entry: TranscriptEntry): void {
  const current = loadTranscript(sessionId);
  current.push(entry);
  saveTranscript(sessionId, current);
}

/** Mutates the most recently appended entry — used to fill in a tool's result once it completes,
 *  or a confirmation's decision once the user picks one, without appending a duplicate entry. */
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
/** The message box's not-yet-sent text, kept per tab so a refresh mid-typing (or a background
 *  reload the browser/OS triggers on its own) doesn't silently discard it. */
export function loadDraft(): string {
  try {
    return sessionStorage.getItem(DRAFT_KEY) ?? "";
  } catch {
    return "";
  }
}

export function saveDraft(text: string): void {
  try {
    if (text) sessionStorage.setItem(DRAFT_KEY, text);
    else sessionStorage.removeItem(DRAFT_KEY);
  } catch {
    // sessionStorage unavailable — the draft just won't survive a reload.
  }
}

export function clearDraft(): void {
  try {
    sessionStorage.removeItem(DRAFT_KEY);
  } catch {
    // no-op
  }
}
