export interface ServerConfig {
  port: number;
  authToken?: string;
  sessionTtlMs: number;
  maxSessions: number;
}

export function loadServerConfig(): ServerConfig {
  return {
    port: Number(process.env.PORT || 8787),
    authToken: process.env.CJW_AUTH_TOKEN,
    sessionTtlMs: Number(process.env.CJW_SESSION_TTL_MIN || 120) * 60_000,
    maxSessions: Number(process.env.CJW_MAX_SESSIONS || 20),
  };
}
