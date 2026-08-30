import { describe, it, expect } from "vitest";

// Test utilities from main.ts
function isValidUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function escapeHtml(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

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
      expect(escapeHtml("<script>alert(1)</script>")).toBe(
        "&lt;script&gt;alert(1)&lt;/script&gt;"
      );
    });

    it("escapes quotes", () => {
      expect(escapeHtml('"test"')).toBe("&quot;test&quot;");
    });

    it("escapes ampersands", () => {
      expect(escapeHtml("a & b")).toBe("a &amp; b");
    });

    it("handles empty strings", () => {
      expect(escapeHtml("")).toBe("");
    });
  });
});
