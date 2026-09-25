import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import {
  ensureUserConfigFile,
  parseUserConfig,
  loadUserConfig,
  generateAuthToken,
  findFreePort,
  buildServerEnv,
} from "../src/serverConfig.js";

describe("parseUserConfig", () => {
  it("reads the four recognized keys and ignores everything else", () => {
    const raw = [
      "# a comment",
      "",
      "CJW_LOCAL_BASE_URL=http://localhost:11434/v1",
      "CJW_DEFAULT_MODEL=qwen2.5-coder:14b",
      "GITHUB_TOKEN=ghp_abc123",
      "CJW_MCP_SERVERS=[]",
      "SOME_UNRELATED_KEY=ignored",
      "not a key-value line",
    ].join("\n");
    expect(parseUserConfig(raw)).toEqual({
      localBaseUrl: "http://localhost:11434/v1",
      defaultModel: "qwen2.5-coder:14b",
      githubToken: "ghp_abc123",
      mcpServers: "[]",
    });
  });

  it("returns an empty object for blank or comment-only input", () => {
    expect(parseUserConfig("# just a comment\n\n")).toEqual({});
  });

  it("tolerates a value containing '=' by splitting on the first one", () => {
    expect(parseUserConfig("CJW_MCP_SERVERS=[{\"url\":\"http://x?a=b\"}]").mcpServers).toBe(
      '[{"url":"http://x?a=b"}]'
    );
  });
});

describe("ensureUserConfigFile / loadUserConfig", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "cjw-desktop-test-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates the file with defaults on first call", () => {
    const file = path.join(dir, "config.env");
    expect(existsSync(file)).toBe(false);
    ensureUserConfigFile(file);
    expect(existsSync(file)).toBe(true);
    const loaded = loadUserConfig(file);
    expect(loaded.localBaseUrl).toBe("http://localhost:11434/v1");
    expect(loaded.defaultModel).toBe("qwen2.5-coder:14b");
  });

  it("never overwrites an existing file", () => {
    const file = path.join(dir, "config.env");
    ensureUserConfigFile(file);
    const edited = "CJW_DEFAULT_MODEL=qwen2.5-coder:32b\n";
    writeFileSync(file, edited);
    ensureUserConfigFile(file);
    expect(readFileSync(file, "utf8")).toBe(edited);
    expect(loadUserConfig(file).defaultModel).toBe("qwen2.5-coder:32b");
  });

  it("returns an empty config for a missing file rather than throwing", () => {
    expect(loadUserConfig(path.join(dir, "nope.env"))).toEqual({});
  });
});

describe("generateAuthToken", () => {
  it("produces a nonempty, URL-safe token that differs each call", () => {
    const a = generateAuthToken();
    const b = generateAuthToken();
    expect(a.length).toBeGreaterThan(16);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe("findFreePort", () => {
  it("returns the preferred port when it's free", async () => {
    const port = await findFreePort(38787);
    expect(port).toBe(38787);
  });

  it("falls back to a different port when the preferred one is taken", async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(38788, "127.0.0.1", resolve));
    try {
      const port = await findFreePort(38788);
      expect(port).not.toBe(38788);
      expect(port).toBeGreaterThan(0);
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });
});

describe("buildServerEnv", () => {
  it("lets user config through but always wins on the app-managed keys", () => {
    const env = buildServerEnv(
      { SOME_INHERITED_VAR: "keep-me" } as NodeJS.ProcessEnv,
      {
        port: 12345,
        authToken: "tok",
        workspacesDir: "/tmp/ws",
        webDistDir: "/tmp/web",
        userConfig: {
          localBaseUrl: "http://example:1234/v1",
          defaultModel: "custom-model",
          githubToken: "ghp_x",
          mcpServers: "[]",
        },
      }
    );
    expect(env.SOME_INHERITED_VAR).toBe("keep-me");
    expect(env.CJW_LOCAL_BASE_URL).toBe("http://example:1234/v1");
    expect(env.CJW_DEFAULT_MODEL).toBe("custom-model");
    expect(env.CJW_HOST).toBe("127.0.0.1");
    expect(env.PORT).toBe("12345");
    expect(env.CJW_AUTH_TOKEN).toBe("tok");
    expect(env.CJW_WORKSPACES_DIR).toBe("/tmp/ws");
    expect(env.CJW_WEB_DIST).toBe("/tmp/web");
  });

  it("falls back to sensible defaults when the user config is empty", () => {
    const env = buildServerEnv({} as NodeJS.ProcessEnv, {
      port: 1,
      authToken: "t",
      workspacesDir: "/w",
      webDistDir: "/web",
      userConfig: {},
    });
    expect(env.CJW_LOCAL_BASE_URL).toBe("http://localhost:11434/v1");
    expect(env.CJW_DEFAULT_MODEL).toBe("qwen2.5-coder:14b");
    expect(env.GITHUB_TOKEN).toBe("");
    expect(env.CJW_MCP_SERVERS).toBe("");
  });
});
