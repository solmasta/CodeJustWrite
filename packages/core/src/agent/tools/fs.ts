import { promises as fs } from "node:fs";
import path from "node:path";
import { createTwoFilesPatch } from "diff";
import type { ToolDefinition } from "./types.js";

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
