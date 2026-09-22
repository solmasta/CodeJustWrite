export interface ServerConfig {
  port: number;
  /** Interface to listen on. Unset = all interfaces (what a hosted deploy needs); the Termux
   *  setup sets 127.0.0.1 so the server is only reachable from the phone itself. */
  host?: string;
  authToken?: string;
  sessionTtlMs: number;
  maxSessions: number;
}

export function loadServerConfig(): ServerConfig {
  return {
    port: Number(process.env.PORT || 8787),
    host: process.env.CJW_HOST || undefined,
    authToken: process.env.CJW_AUTH_TOKEN,
    sessionTtlMs: Number(process.env.CJW_SESSION_TTL_MIN || 120) * 60_000,
    maxSessions: Number(process.env.CJW_MAX_SESSIONS || 20),
  };
}
