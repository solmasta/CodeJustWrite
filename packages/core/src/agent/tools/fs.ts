import { promises as fs } from "node:fs";
import path from "node:path";
import { createTwoFilesPatch } from "diff";
import { execSandboxed } from "../../sandbox/exec.js";
import type { ToolDefinition } from "./types.js";

// Cap on search_files output so a broad pattern can't flood the context.
const MAX_SEARCH_RESULTS = 200;

// Maximum file size: 1MB
const MAX_FILE_SIZE = 1024 * 1024;

function resolveInRepo(repoRoot: string, relPath: string): string {
  // Normalize paths for cross-platform compatibility
  const normalizedRoot = path.resolve(repoRoot);
  const resolved = path.resolve(normalizedRoot, relPath);
  
  // Security check: resolved path must be within repo root
  // Handle both forward and back slashes on Windows
  const resolvedLower = resolved.toLowerCase();
  const rootLower = normalizedRoot.toLowerCase();
  const sep = path.sep;
  
  if (resolved !== normalizedRoot && !resolvedLower.startsWith(rootLower + sep) && !resolvedLower.startsWith(rootLower + "/")) {
    throw new Error(`Path "${relPath}" escapes the repository root — refusing.`);
  }
  
  return resolved;
}

function validateFilename(name: string): void {
  // Reject filenames with null bytes
  if (name.includes("\0")) {
    throw new Error("Filename contains null bytes");
  }
  // Reject control characters
  // eslint-disable-next-line no-control-regex -- intentional: scanning for control chars
  if (/[\x00-\x1f\x7f]/.test(name)) {
    throw new Error("Filename contains control characters");
  }
}

async function readTextFile(filePath: string): Promise<string> {
  // Check file size before reading
  const stats = await fs.stat(filePath).catch(() => null);
  if (stats && stats.size > MAX_FILE_SIZE) {
    throw new Error(`File too large (${stats.size} bytes, max ${MAX_FILE_SIZE})`);
  }
  return fs.readFile(filePath, "utf8");
}

async function writeTextFile(filePath: string, content: string): Promise<void> {
  // Validate content size
  if (Buffer.byteLength(content, "utf8") > MAX_FILE_SIZE) {
    throw new Error(`Content too large (max ${MAX_FILE_SIZE} bytes)`);
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
}

function patchDiff(filePath: string, before: string, after: string): string {
  return createTwoFilesPatch(filePath, filePath, before, after);
}

function numberedLines(content: string): string {
  return content.split("\n").map((line, i) => `${i + 1}\t${line}`).join("\n");
}

export const readFileTool: ToolDefinition = {
  spec: {
    name: "read_file",
    description: "Read the contents of a text file in the repository, given a path relative to the repo root.",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "Path relative to the repo root." } },
      required: ["path"],
    },
  },
  readOnly: true,
  async run(args, ctx) {
    const relPath = String(args.path);
    validateFilename(relPath);
    const content = await readTextFile(resolveInRepo(ctx.repoRoot, relPath));
    return numberedLines(content);
  },
};

export const listDirTool: ToolDefinition = {
  spec: {
    name: "list_dir",
    description: "List files and directories at a given path relative to the repo root (non-recursive).",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "Path relative to the repo root. Use '.' for the repo root." } },
      required: ["path"],
    },
  },
  readOnly: true,
  async run(args, ctx) {
    const relPath = String(args.path);
    validateFilename(relPath);
    const entries = await fs.readdir(resolveInRepo(ctx.repoRoot, relPath), { withFileTypes: true });
    return entries
      .map((e) => `${e.isDirectory() ? "d" : "f"} ${e.name}`)
      .sort()
      .join("\n");
  },
};

export const writeFileTool: ToolDefinition = {
  spec: {
    name: "write_file",
    description: "Create or fully overwrite a text file at the given path relative to the repo root.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the repo root." },
        content: { type: "string", description: "Full file content to write." },
      },
      required: ["path", "content"],
    },
  },
  requiresConfirmation: true,
  async run(args, ctx) {
    const relPath = String(args.path);
    validateFilename(relPath);
    const p = resolveInRepo(ctx.repoRoot, relPath);
    const before = await readTextFile(p).catch(() => "");
    const after = String(args.content);
    ctx.log(patchDiff(relPath, before, after));
    await writeTextFile(p, after);
    return `Wrote ${after.length} bytes to ${relPath}`;
  },
};

export const editFileTool: ToolDefinition = {
  spec: {
    name: "edit_file",
    description: "Replace an exact, unique occurrence of `find` with `replace` in an existing file.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the repo root." },
        find: { type: "string", description: "Exact text to locate (must match exactly once)." },
        replace: { type: "string", description: "Text to replace it with." },
      },
      required: ["path", "find", "replace"],
    },
  },
  requiresConfirmation: true,
  async run(args, ctx) {
    const relPath = String(args.path);
    validateFilename(relPath);
    const p = resolveInRepo(ctx.repoRoot, relPath);
    const before = await readTextFile(p);
    const find = String(args.find);
    const occurrences = before.split(find).length - 1;

    if (occurrences === 0) throw new Error(`find text not found in ${relPath}`);
    if (occurrences > 1) throw new Error(`find text is not unique in ${relPath} (${occurrences} matches)`);

    const after = before.replace(find, String(args.replace));
    ctx.log(patchDiff(relPath, before, after));
    await writeTextFile(p, after);
    return `Edited ${relPath}`;
  },
};

export const deleteFileTool: ToolDefinition = {
  spec: {
    name: "delete_file",
    description: "Delete a file at the given path relative to the repo root.",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "Path relative to the repo root." } },
      required: ["path"],
    },
  },
  requiresConfirmation: true,
  async run(args, ctx) {
    const relPath = String(args.path);
    validateFilename(relPath);
    const p = resolveInRepo(ctx.repoRoot, relPath);
    await fs.unlink(p);
    return `Deleted ${relPath}`;
  },
};

export const searchFilesTool: ToolDefinition = {
  spec: {
    name: "search_files",
    description:
      "Search tracked (and newly-created, not-yet-committed) files in the repository for a regex pattern " +
      "— like `grep -rn`, but automatically skips gitignored files (node_modules, dist, etc.). Returns " +
      "matches as path:line:text. Use this instead of read_file/list_dir to find where something is " +
      "defined or used before reading individual files.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Extended-regex pattern to search for." },
        path: {
          type: "string",
          description: "Optional path or glob to scope the search to, relative to the repo root.",
        },
        caseInsensitive: { type: "boolean", description: "Case-insensitive match. Defaults to false." },
      },
      required: ["pattern"],
    },
  },
  requiresConfirmation: false,
  readOnly: true,
  async run(args, ctx) {
    const pattern = String(args.pattern ?? "");
    if (!pattern) throw new Error("pattern is required");

    // git grep, not a raw shell grep: it's already available (git is a hard runtime dependency),
    // it's fast even in large repos, and it naturally skips whatever the repo's .gitignore skips
    // without the tool needing its own node_modules/dist/.git exclusion list. --untracked also
    // picks up files the agent itself just created via write_file, before they're ever committed.
    const gitArgs = ["grep", "--untracked", "-n", "-I", "-E"];
    if (args.caseInsensitive) gitArgs.push("-i");
    gitArgs.push("-e", pattern);
    if (args.path) {
      const relPath = String(args.path);
      validateFilename(relPath);
      gitArgs.push("--", relPath);
    }

    const result = await execSandboxed("git", gitArgs, { cwd: ctx.repoRoot, timeoutSec: 30 });
    // git grep exits 1 for "ran fine, no matches" — only >1 is a real error (e.g. bad regex).
    if (result.code !== 0 && result.code !== 1) {
      throw new Error(result.stderr || result.stdout || `git grep exited with code ${result.code}`);
    }
    if (!result.stdout.trim()) return "No matches found.";

    const lines = result.stdout.split("\n").filter(Boolean);
    const shown = lines.slice(0, MAX_SEARCH_RESULTS);
    const suffix =
      lines.length > MAX_SEARCH_RESULTS
        ? `\n… truncated to ${MAX_SEARCH_RESULTS} of ${lines.length} matches — narrow the pattern or path.`
        : "";
    return shown.join("\n") + suffix;
  },
};
