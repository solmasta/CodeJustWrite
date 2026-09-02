const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const OAUTH_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const DRIVE_FILES_URL = "https://www.googleapis.com/drive/v3/files";
const DRIVE_UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3/files";
const BACKUP_ROOT_FOLDER_NAME = "CodeJustWrite Backups";
// drive.file (not full drive access) — the app can only see/write files it created itself, so a
// leaked refresh token exposes nothing else in the account's Drive.
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
}

/** Builds the URL to send the browser to for the one-time interactive consent flow that
 *  produces a refresh token — see the /api/google/connect route. `state` round-trips back
 *  unchanged in the callback, which is how that route is authenticated (Google's redirect can't
 *  carry a bearer header). */
export function buildGoogleAuthUrl(config: GoogleOAuthConfig, redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: DRIVE_SCOPE,
    access_type: "offline",
    prompt: "consent", // without this, re-consenting an already-authorized account omits refresh_token
    state,
  });
  return `${OAUTH_AUTH_URL}?${params.toString()}`;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}

async function requestToken(config: GoogleOAuthConfig, body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, ...body }).toString(),
  });
  if (!res.ok) {
    throw new Error(`Google token endpoint error (${res.status}): ${await res.text().catch(() => res.statusText)}`);
  }
  return res.json() as Promise<TokenResponse>;
}

/** One-time exchange of the authorization code Google's redirect carries for a long-lived
 *  refresh token — the code is single-use and expires in minutes, so this only ever runs once
 *  during the interactive bootstrap in /api/google/callback; the resulting refresh token is what
 *  every later backup actually authenticates with. */
export async function exchangeCodeForRefreshToken(
  config: GoogleOAuthConfig,
  code: string,
  redirectUri: string
): Promise<string> {
  const tokens = await requestToken(config, { code, redirect_uri: redirectUri, grant_type: "authorization_code" });
  if (!tokens.refresh_token) {
    throw new Error(
      "Google did not return a refresh token — if this account already granted access before, revoke it at " +
        "https://myaccount.google.com/permissions and try connecting again (Google only issues a refresh " +
        "token on first consent)."
    );
  }
  return tokens.refresh_token;
}

/** Refresh tokens don't expire on their own; access tokens do (~1hr) — every backup gets a
 *  fresh one rather than trying to cache/reuse one across requests. */
export async function getAccessToken(config: GoogleOAuthConfig, refreshToken: string): Promise<string> {
  const tokens = await requestToken(config, { refresh_token: refreshToken, grant_type: "refresh_token" });
  return tokens.access_token;
}

function escapeDriveQueryValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

async function driveApiFetch(accessToken: string, url: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${accessToken}`, ...init.headers },
  });
  if (!res.ok) {
    throw new Error(`Drive API error (${res.status}): ${await res.text().catch(() => res.statusText)}`);
  }
  return res;
}

async function findFolder(accessToken: string, name: string, parentId: string): Promise<string | null> {
  const q =
    `mimeType='application/vnd.google-apps.folder' and name='${escapeDriveQueryValue(name)}' ` +
    `and '${parentId}' in parents and trashed=false`;
  const res = await driveApiFetch(accessToken, `${DRIVE_FILES_URL}?q=${encodeURIComponent(q)}&fields=files(id)&spaces=drive`);
  const data = (await res.json()) as { files?: { id: string }[] };
  return data.files?.[0]?.id ?? null;
}

async function createFolder(accessToken: string, name: string, parentId: string): Promise<string> {
  const res = await driveApiFetch(accessToken, `${DRIVE_FILES_URL}?fields=id`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, mimeType: "application/vnd.google-apps.folder", parents: [parentId] }),
  });
  const data = (await res.json()) as { id: string };
  return data.id;
}

async function findOrCreateFolder(accessToken: string, name: string, parentId: string): Promise<string> {
  const existing = await findFolder(accessToken, name, parentId);
  if (existing) return existing;
  return createFolder(accessToken, name, parentId);
}

/** Ensures "CodeJustWrite Backups/<repoName>" exists (creating whichever levels don't yet), and
 *  returns the repo-specific folder's id — every backup for that repo lands in that same folder,
 *  a new timestamped file per save/session, so nothing gets overwritten. */
export async function ensureBackupFolder(accessToken: string, repoName: string): Promise<string> {
  const rootId = await findOrCreateFolder(accessToken, BACKUP_ROOT_FOLDER_NAME, "root");
  return findOrCreateFolder(accessToken, repoName, rootId);
}

/** Uploads a small text backup file into the given folder. Drive's simple multipart upload is
 *  plenty for a conversation-summary note — no need for the resumable upload protocol. */
export async function uploadBackupFile(
  accessToken: string,
  folderId: string,
  filename: string,
  markdown: string
): Promise<{ id: string; webViewLink: string }> {
  const boundary = `cjw-${Math.random().toString(36).slice(2)}`;
  const metadata = JSON.stringify({ name: filename, parents: [folderId], mimeType: "text/markdown" });
  const body =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: text/markdown; charset=UTF-8\r\n\r\n${markdown}\r\n` +
    `--${boundary}--`;

  const res = await driveApiFetch(accessToken, `${DRIVE_UPLOAD_URL}?uploadType=multipart&fields=id,webViewLink`, {
    method: "POST",
    headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
    body,
  });
  return res.json() as Promise<{ id: string; webViewLink: string }>;
}
