/**
 * Embeds a GitHub token into an https://github.com clone URL so that both
 * the initial clone AND every later `git push` against the resulting
 * `origin` remote authenticate automatically — a session has no other
 * credential store (no SSH key, no `gh` login) on this headless server.
 * SSH URLs, non-GitHub hosts, and unparsable URLs pass through untouched.
 */
export function withGithubToken(repoUrl: string, token: string | undefined): string {
  if (!token) return repoUrl;
  let url: URL;
  try {
    url = new URL(repoUrl);
  } catch {
    return repoUrl; // e.g. scp-like `git@github.com:owner/repo.git` — leave SSH auth alone
  }
  if (url.protocol !== "https:" || !/(^|\.)github\.com$/i.test(url.hostname)) return repoUrl;
  url.username = "x-access-token";
  url.password = token;
  return url.toString();
}

/** Replaces every occurrence of any given secret in a string with `***`. */
function redactString(value: string, secrets: string[]): string {
  let out = value;
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join("***");
  }
  return out;
}

/**
 * Recursively scrubs configured secrets (API keys, GitHub token) out of any
 * string found in a value before it's sent to a client — defense in depth
 * in case one leaks into tool output, a git error message, or a diff.
 */
export function redactSecrets<T>(value: T, secrets: string[]): T {
  if (typeof value === "string") return redactString(value, secrets) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactSecrets(v, secrets)) as unknown as T;
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = redactSecrets(v, secrets);
    }
    return result as T;
  }
  return value;
}
