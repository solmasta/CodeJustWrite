import { describe, it, expect } from "vitest";
import { isValidUrl, escapeHtml, buildExportFilename } from "./utils";

describe("main utilities", () => {
  describe("isValidUrl", () => {
    it("accepts valid http URLs", () => {
      expect(isValidUrl("http://localhost:3000")).toBe(true);
      expect(isValidUrl("http://example.com")).toBe(true);
    });

    it("accepts valid https URLs", () => {
      expect(isValidUrl("https://localhost:3000")).toBe(true);
      expect(isValidUrl("https://example.com/path")).toBe(true);
    });

    it("rejects invalid URLs", () => {
      expect(isValidUrl("not-a-url")).toBe(false);
      expect(isValidUrl("")).toBe(false);
    });

    it("rejects non-http protocols", () => {
      expect(isValidUrl("ftp://example.com")).toBe(false);
      expect(isValidUrl("file:///etc/passwd")).toBe(false);
      expect(isValidUrl("javascript:alert(1)")).toBe(false);
    });
  });

  describe("escapeHtml", () => {
    it("escapes HTML special characters", () => {
      expect(escapeHtml("<script>alert(1)</script>")).toBe("&lt;script&gt;alert(1)&lt;/script&gt;");
    });

    it("escapes ampersands", () => {
      expect(escapeHtml("a & b")).toBe("a &amp; b");
    });

    it("handles empty strings", () => {
      expect(escapeHtml("")).toBe("");
    });

    it("leaves plain text untouched", () => {
      expect(escapeHtml("hello world")).toBe("hello world");
    });
  });

  describe("buildExportFilename", () => {
    it("uses the server-provided slug when given", () => {
      expect(buildExportFilename("fix-oom-leak", "my-repo", "2026-01-01T00-00-00")).toBe(
        "fix-oom-leak-2026-01-01T00-00-00.md"
      );
    });

    it("falls back to the repoName-based scheme when there's no slug", () => {
      expect(buildExportFilename(null, "my-repo", "2026-01-01T00-00-00")).toBe(
        "codejustwrite-my-repo-2026-01-01T00-00-00.md"
      );
    });

    it("replaces slashes in the repoName fallback so it stays a single valid filename", () => {
      expect(buildExportFilename(null, "org/my-repo", "2026-01-01T00-00-00")).toBe(
        "codejustwrite-org-my-repo-2026-01-01T00-00-00.md"
      );
    });
  });
});
