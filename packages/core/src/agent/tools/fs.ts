import { promises as fs } from "node:fs";
import path from "node:path";
import { createTwoFilesPatch } from "diff";
import type { ToolDefinition } from "./types.js";

function resolveInRepo(repoRoot: string, relPath: string): string {
  const resolved = path.resolve(repoRoot, relPath);
  const normalizedRoot = path.resolve(repoRoot);
  if (resolved !== normalizedRoot && !resolved.startsWith(normalizedRoot + path.sep)) {
    throw new Error(`Path "${relPath}" escapes the repository root — refusing.`);
  }
  return resolved;
}

async function readTextFile(filePath: string): Promise<string> {
  return fs.readFile(filePath, "utf8");
}

async function writeTextFile(filePath: string, content: string): Promise<void> {
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
    const content = await readTextFile(resolveInRepo(ctx.repoRoot, String(args.path)));
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
    const entries = await fs.readdir(resolveInRepo(ctx.repoRoot, String(args.path)), { withFileTypes: true });
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
    const p = resolveInRepo(ctx.repoRoot, String(args.path));
    const before = await readTextFile(p).catch(() => "");
    const after = String(args.content);
    ctx.log(patchDiff(String(args.path), before, after));
    await writeTextFile(p, after);
    return `Wrote ${after.length} bytes to ${args.path}`;
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
    const p = resolveInRepo(ctx.repoRoot, String(args.path));
    const filePath = String(args.path);
    const before = await readTextFile(p);
    const find = String(args.find);
    const occurrences = before.split(find).length - 1;

    if (occurrences === 0) throw new Error(`find text not found in ${filePath}`);
    if (occurrences > 1) throw new Error(`find text is not unique in ${filePath} (${occurrences} matches)`);

    const after = before.replace(find, String(args.replace));
    ctx.log(patchDiff(filePath, before, after));
    await writeTextFile(p, after);
    return `Edited ${filePath}`;
  },
};