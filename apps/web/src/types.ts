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
  provider: "deepinfra" | "openrouter";
  model: string;
  autoApprove: boolean;
  recentRepos: RepoInfo[];
}

/**
 * The in-progress session a tab is connected to. Kept in sessionStorage
 * (tab-scoped) rather than Settings' localStorage (shared across tabs) so
 * opening a second tab starts a genuinely independent session instead of
 * silently overwriting the first tab's on the next reload.
 */
export interface ActiveSession {
  sessionId: string;
  repoName: string;
}

export interface ServerMessage {
  type:
    | "assistant_delta"
    | "assistant_done"
    | "tool_call"
    | "tool_result"
    | "diff"
    | "awaiting_confirmation"
    | "error"
    | "state"
    | "models";
  text?: string;
  name?: string;
  args?: unknown;
  result?: string;
  error?: boolean;
  callId?: string;
  question?: string;
  message?: string;
  provider?: string;
  model?: string;
  autoApprove?: boolean;
  repoRoot?: string;
  models?: { id: string }[];
}

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}
