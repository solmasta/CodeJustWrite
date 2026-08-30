import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadConfig } from "../src/config/config.js";

const ENV_KEY = "CJW_MCP_SERVERS";

describe("loadConfig CJW_MCP_SERVERS parsing", () => {
  const original = process.env[ENV_KEY];

  beforeEach(() => {
    delete process.env[ENV_KEY];
  });

  afterEach(() => {
    if (original === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = original;
  });

  it("defaults to an empty array when unset", () => {
    expect(loadConfig().mcpServers).toEqual([]);
  });

  it("parses a valid stdio + http server list", () => {
    process.env[ENV_KEY] = JSON.stringify([
      { name: "github", transport: "stdio", command: "npx", args: ["-y", "server-github"], apiKey: "tok", apiKeyEnvVar: "GITHUB_PERSONAL_ACCESS_TOKEN" },
      { name: "render", transport: "http", url: "https://mcp.render.com/mcp", apiKey: "rnd_x" },
    ]);
    expect(loadConfig().mcpServers).toEqual([
      { name: "github", transport: "stdio", command: "npx", args: ["-y", "server-github"], url: undefined, apiKey: "tok", apiKeyEnvVar: "GITHUB_PERSONAL_ACCESS_TOKEN" },
      { name: "render", transport: "http", command: undefined, args: undefined, url: "https://mcp.render.com/mcp", apiKey: "rnd_x", apiKeyEnvVar: undefined },
    ]);
  });

  it("ignores malformed JSON rather than throwing", () => {
    process.env[ENV_KEY] = "{not json";
    expect(loadConfig().mcpServers).toEqual([]);
  });

  it("ignores a non-array value", () => {
    process.env[ENV_KEY] = JSON.stringify({ name: "github" });
    expect(loadConfig().mcpServers).toEqual([]);
  });

  it("ignores an entry missing the fields its transport requires", () => {
    process.env[ENV_KEY] = JSON.stringify([{ name: "github", transport: "stdio" }]);
    expect(loadConfig().mcpServers).toEqual([]);
  });
});
