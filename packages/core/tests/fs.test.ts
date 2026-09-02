import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { execSandboxed } from "../src/sandbox/exec.js";
import {
  readFileTool,
  writeFileTool,
  editFileTool,
  listDirTool,
  deleteFileTool,
  searchFilesTool,
} from "../src/agent/tools/fs.js";
import { makeCtx, tempDir } from "./testUtils.js";

async function initGitRepo(dir: string): Promise<void> {
  await execSandboxed("git init -q -b main", { cwd: dir, timeoutSec: 10 });
  await execSandboxed('git config user.email "test@example.com"', { cwd: dir, timeoutSec: 10 });
  await execSandboxed('git config user.name "Test"', { cwd: dir, timeoutSec: 10 });
}

describe("fs tools", () => {
  it("writes then reads a file with line numbers", async () => {
    const dir = tempDir("cjw-fs-");
    const ctx = makeCtx(dir);

    await writeFileTool.run({ path: "hello.txt", content: "line one\nline two" }, ctx);
    const read = await readFileTool.run({ path: "hello.txt" }, ctx);

    expect(read).toBe("1\tline one\n2\tline two");
  });

  it("lists directory entries", async () => {
    const dir = tempDir("cjw-fs-");
    const ctx = makeCtx(dir);
    await fs.mkdir(path.join(dir, "sub"));
    await fs.writeFile(path.join(dir, "a.txt"), "x");

    const listing = await listDirTool.run({ path: "." }, ctx);
    expect(listing).toContain("f a.txt");
    expect(listing).toContain("d sub");
  });

  it("edit_file replaces a unique match", async () => {
    const dir = tempDir("cjw-fs-");
    const ctx = makeCtx(dir);
    await writeFileTool.run({ path: "f.txt", content: "const x = 1;" }, ctx);

    await editFileTool.run({ path: "f.txt", find: "const x = 1;", replace: "const x = 2;" }, ctx);
    const content = await fs.readFile(path.join(dir, "f.txt"), "utf8");
    expect(content).toBe("const x = 2;");
  });

  it("edit_file rejects a non-unique match", async () => {
    const dir = tempDir("cjw-fs-");
    const ctx = makeCtx(dir);
    await writeFileTool.run({ path: "f.txt", content: "dup\ndup" }, ctx);

    await expect(editFileTool.run({ path: "f.txt", find: "dup", replace: "x" }, ctx)).rejects.toThrow(/not unique/);
  });

  it("delete_file removes the file", async () => {
    const dir = tempDir("cjw-fs-");
    const ctx = makeCtx(dir);
    await writeFileTool.run({ path: "gone.txt", content: "bye" }, ctx);

    await deleteFileTool.run({ path: "gone.txt" }, ctx);
    await expect(fs.access(path.join(dir, "gone.txt"))).rejects.toThrow();
  });

  it("search_files finds a pattern across untracked files, skipping gitignored ones", async () => {
    const dir = tempDir("cjw-fs-");
    const ctx = makeCtx(dir);
    await initGitRepo(dir);
    await fs.writeFile(path.join(dir, ".gitignore"), "ignored.txt\n");
    await writeFileTool.run({ path: "a.ts", content: "export function needle() {}" }, ctx);
    await writeFileTool.run({ path: "ignored.txt", content: "needle should not show up" }, ctx);

    const result = await searchFilesTool.run({ pattern: "needle" }, ctx);
    expect(result).toContain("a.ts");
    expect(result).not.toContain("ignored.txt");
  });

  it("search_files reports no matches without throwing", async () => {
    const dir = tempDir("cjw-fs-");
    const ctx = makeCtx(dir);
    await initGitRepo(dir);
    await writeFileTool.run({ path: "a.ts", content: "nothing interesting" }, ctx);

    const result = await searchFilesTool.run({ pattern: "definitely-not-present" }, ctx);
    expect(result).toBe("No matches found.");
  });

  it("refuses to read/write paths that escape the repo root", async () => {
    const dir = tempDir("cjw-fs-");
    const ctx = makeCtx(dir);

    await expect(readFileTool.run({ path: "../../etc/passwd" }, ctx)).rejects.toThrow(/escapes the repository root/);
    await expect(writeFileTool.run({ path: "../evil.txt", content: "x" }, ctx)).rejects.toThrow(
      /escapes the repository root/
    );
  });
});
