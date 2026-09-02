export interface ServerConfig {
  port: number;
  authToken?: string;
  sessionTtlMs: number;
  maxSessions: number;
  /** Google Drive backup ("Save to Drive" — see googleDrive.ts). All three must be set for the
   *  feature to appear; googleRefreshToken only exists after the one-time interactive consent
   *  flow at /api/google/connect has been completed and its result copied in here. */
  googleClientId?: string;
  googleClientSecret?: string;
  googleRefreshToken?: string;
}

export function loadServerConfig(): ServerConfig {
  return {
    port: Number(process.env.PORT || 8787),
    authToken: process.env.CJW_AUTH_TOKEN,
    sessionTtlMs: Number(process.env.CJW_SESSION_TTL_MIN || 120) * 60_000,
    maxSessions: Number(process.env.CJW_MAX_SESSIONS || 20),
    googleClientId: process.env.CJW_GOOGLE_CLIENT_ID,
    googleClientSecret: process.env.CJW_GOOGLE_CLIENT_SECRET,
    googleRefreshToken: process.env.CJW_GOOGLE_REFRESH_TOKEN,
  };
}
