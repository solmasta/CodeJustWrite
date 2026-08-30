import { describe, it, expect } from "vitest";
import { withGithubToken, redactSecrets } from "../src/secrets.js";

describe("withGithubToken", () => {
  it("embeds the token as x-access-token for a github.com https URL", () => {
    const result = withGithubToken("https://github.com/owner/repo.git", "abc123");
    expect(result).toBe("https://x-access-token:abc123@github.com/owner/repo.git");
  });

  it("leaves the URL untouched when no token is configured", () => {
    expect(withGithubToken("https://github.com/owner/repo.git", undefined)).toBe(
      "https://github.com/owner/repo.git"
    );
  });

  it("leaves SSH (scp-like) URLs untouched", () => {
    const url = "git@github.com:owner/repo.git";
    expect(withGithubToken(url, "abc123")).toBe(url);
  });

  it("leaves non-GitHub hosts untouched", () => {
    const url = "https://gitlab.com/owner/repo.git";
    expect(withGithubToken(url, "abc123")).toBe(url);
  });

  it("leaves unparsable URLs untouched", () => {
    const url = "not a url";
    expect(withGithubToken(url, "abc123")).toBe(url);
  });
});

describe("redactSecrets", () => {
  it("redacts a secret found in a plain string", () => {
    expect(redactSecrets("token is abc123 here", ["abc123"])).toBe("token is *** here");
  });

  it("redacts secrets nested inside objects and arrays", () => {
    const input = { a: "has abc123", b: ["nested abc123 too", { c: "abc123" }] };
    expect(redactSecrets(input, ["abc123"])).toEqual({
      a: "has ***",
      b: ["nested *** too", { c: "***" }],
    });
  });

  it("is a no-op with an empty secrets list", () => {
    expect(redactSecrets("abc123", [])).toBe("abc123");
  });

  it("leaves non-string values (numbers, booleans, null) untouched", () => {
    expect(redactSecrets({ n: 1, b: true, x: null }, ["abc123"])).toEqual({ n: 1, b: true, x: null });
  });
});
