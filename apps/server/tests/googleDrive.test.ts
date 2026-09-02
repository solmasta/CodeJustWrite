import { describe, it, expect, vi, afterEach } from "vitest";
import {
  buildGoogleAuthUrl,
  exchangeCodeForRefreshToken,
  getAccessToken,
  ensureBackupFolder,
  uploadBackupFile,
} from "../src/googleDrive.js";

const config = { clientId: "client-123", clientSecret: "secret-abc" };

function jsonResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    statusText: ok ? "OK" : "Error",
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

describe("buildGoogleAuthUrl", () => {
  it("includes the client id, redirect uri, drive.file scope, offline access, and state", () => {
    const url = new URL(buildGoogleAuthUrl(config, "https://app.example/api/google/callback", "tok-xyz"));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("client_id")).toBe("client-123");
    expect(url.searchParams.get("redirect_uri")).toBe("https://app.example/api/google/callback");
    expect(url.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/drive.file");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("state")).toBe("tok-xyz");
  });
});

describe("exchangeCodeForRefreshToken", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns the refresh token from a successful exchange", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ access_token: "at", refresh_token: "rt-1", expires_in: 3600 }))
    );
    const token = await exchangeCodeForRefreshToken(config, "auth-code", "https://app.example/cb");
    expect(token).toBe("rt-1");
  });

  it("throws a clear error when Google doesn't return a refresh token (re-consent case)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ access_token: "at", expires_in: 3600 })));
    await expect(exchangeCodeForRefreshToken(config, "auth-code", "https://app.example/cb")).rejects.toThrow(
      /did not return a refresh token/
    );
  });

  it("throws on a non-ok token endpoint response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: "invalid_grant" }, false, 400)));
    await expect(exchangeCodeForRefreshToken(config, "bad-code", "https://app.example/cb")).rejects.toThrow(
      /Google token endpoint error \(400\)/
    );
  });
});

describe("getAccessToken", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("exchanges a refresh token for a fresh access token", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ access_token: "fresh-at", expires_in: 3600 }));
    vi.stubGlobal("fetch", fetchMock);

    const token = await getAccessToken(config, "rt-1");
    expect(token).toBe("fresh-at");

    const [, init] = fetchMock.mock.calls[0];
    const body = new URLSearchParams(init.body as string);
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("rt-1");
    expect(body.get("client_secret")).toBe("secret-abc");
  });
});

describe("ensureBackupFolder", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reuses an existing root and repo folder instead of creating duplicates", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ files: [{ id: "root-id" }] })) // find root folder
      .mockResolvedValueOnce(jsonResponse({ files: [{ id: "repo-id" }] })); // find repo folder
    vi.stubGlobal("fetch", fetchMock);

    const folderId = await ensureBackupFolder("access-tok", "owner/repo");
    expect(folderId).toBe("repo-id");
    expect(fetchMock).toHaveBeenCalledTimes(2); // no create calls needed

    const firstUrl = new URL(fetchMock.mock.calls[0][0] as string);
    expect(firstUrl.searchParams.get("q")).toContain("CodeJustWrite Backups");
    const secondUrl = new URL(fetchMock.mock.calls[1][0] as string);
    expect(secondUrl.searchParams.get("q")).toContain("owner/repo");
    expect(secondUrl.searchParams.get("q")).toContain("'root-id' in parents");
  });

  it("creates the root and/or repo folder when they don't exist yet", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ files: [] })) // root not found
      .mockResolvedValueOnce(jsonResponse({ id: "new-root-id" })) // create root
      .mockResolvedValueOnce(jsonResponse({ files: [] })) // repo folder not found
      .mockResolvedValueOnce(jsonResponse({ id: "new-repo-id" })); // create repo folder
    vi.stubGlobal("fetch", fetchMock);

    const folderId = await ensureBackupFolder("access-tok", "owner/repo");
    expect(folderId).toBe("new-repo-id");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("escapes single quotes in a repo name before building the Drive search query", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ files: [{ id: "root-id" }] }))
      .mockResolvedValueOnce(jsonResponse({ files: [{ id: "repo-id" }] }));
    vi.stubGlobal("fetch", fetchMock);

    await ensureBackupFolder("access-tok", "owner/it's-a-repo");
    const secondUrl = new URL(fetchMock.mock.calls[1][0] as string);
    expect(secondUrl.searchParams.get("q")).toContain("it\\'s-a-repo");
  });
});

describe("uploadBackupFile", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("posts a multipart request with the filename, parent folder, and markdown content", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: "file-1", webViewLink: "https://drive/file-1" }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await uploadBackupFile("access-tok", "folder-1", "2026-01-01.md", "# Hello\n\nBody text");
    expect(result).toEqual({ id: "file-1", webViewLink: "https://drive/file-1" });

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("uploadType=multipart");
    expect(init.headers.Authorization).toBe("Bearer access-tok");
    expect(init.body).toContain("\"name\":\"2026-01-01.md\"");
    expect(init.body).toContain("\"parents\":[\"folder-1\"]");
    expect(init.body).toContain("# Hello\n\nBody text");
  });

  it("throws a clear error on a non-ok Drive API response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: "quota exceeded" }, false, 403)));
    await expect(uploadBackupFile("access-tok", "folder-1", "f.md", "content")).rejects.toThrow(
      /Drive API error \(403\)/
    );
  });
});
