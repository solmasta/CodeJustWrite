import { promises as fs } from "node:fs";
import path from "node:path";
import { createTwoFilesPatch } from "diff";
import type { ToolDefinition } from "./types.js";

/** Resolves a path the model gave us and refuses to leave the repo root. */
function resolveInRepo(repoRoot: string, relPath: string): string {
  const resolved = path.resolve(repoRoot, relPath);
  const normalizedRoot = path.resolve(repoRoot);
  if (resolved !== normalizedRoot && !resolved.startsWith(normalizedRoot + path.sep)) {
    throw new Error(`Path "${relPath}" escapes the repository root — refusing.`);
  }
  return resolved;
}

export const readFileTool: ToolDefinition = {
  spec: {
    name: "read_file",
    description: "Read the contents of a text file in the repository, given a path relative to the repo root.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the repo root." },
      },
      required: ["path"],
    },
  },
  async run(args, ctx) {
    const p = resolveInRepo(ctx.repoRoot, String(args.path));
    const content = await fs.readFile(p, "utf8");
    const numbered = content
      .split("\n")
      .map((line, i) => `${i + 1}\t${line}`)
      .join("\n");
    return numbered;
  },
};

export const listDirTool: ToolDefinition = {
  spec: {
    name: "list_dir",
    description: "List files and directories at a given path relative to the repo root (non-recursive).",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the repo root. Use '.' for the repo root." },
      },
      required: ["path"],
    },
  },
  async run(args, ctx) {
    const p = resolveInRepo(ctx.repoRoot, String(args.path));
    const entries = await fs.readdir(p, { withFileTypes: true });
    return entries
      .map((e) => `${e.isDirectory() ? "d" : "f"} ${e.name}`)
      .sort()
      .join("\n");
  },
};

export const writeFileTool: ToolDefinition = {
  spec: {
    name: "write_file",
    description:
      "Create or fully overwrite a text file at the given path relative to the repo root. Prefer edit_file for small changes to existing files.",
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
    let before = "";
    try {
      before = await fs.readFile(p, "utf8");
    } catch {
      // new file
    }
    const after = String(args.content);
    const patch = createTwoFilesPatch(String(args.path), String(args.path), before, after);
    ctx.log(patch);

    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, after, "utf8");
    return `Wrote ${after.length} bytes to ${args.path}`;
  },
};

export const editFileTool: ToolDefinition = {
  spec: {
    name: "edit_file",
    description:
      "Replace an exact, unique occurrence of `find` with `replace` in an existing file. Fails if `find` is not found exactly once, so include enough surrounding context to make it unique.",
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
    const before = await fs.readFile(p, "utf8");
    const find = String(args.find);
    const occurrences = before.split(find).length - 1;
    if (occurrences === 0) {
      throw new Error(`find text not found in ${args.path}`);
    }
    if (occurrences > 1) {
      throw new Error(`find text is not unique in ${args.path} (${occurrences} matches) — add more context.`);
    }
    const after = before.replace(find, String(args.replace));
    const patch = createTwoFilesPatch(String(args.path), String(args.path), before, after);
    ctx.log(patch);

    await fs.writeFile(p, after, "utf8");
    return `Edited ${args.path}`;
  },
};
