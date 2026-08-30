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

export interface ServerMessage {
  type:
    | "assistant_delta"
    | "assistant_done"
    | "tool_call"
    | "tool_result"
    | "diff"
    | "awaiting_confirmation"
    | "error"
    | "state";
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
}

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}
