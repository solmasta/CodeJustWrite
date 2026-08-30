import type { RepoInfo } from "./settings";

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
  type: "assistant_delta" | "assistant_done" | "tool_start" | "tool_done" | "error" | "system" | "state";
  text?: string;
  tool?: string;
  message?: string;
}

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}
