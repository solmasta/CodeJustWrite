import { readFileTool, listDirTool, writeFileTool, editFileTool } from "./fs.js";
import { runShellTool } from "./shell.js";
import {
  gitStatusTool,
  gitDiffTool,
  gitCreateBranchTool,
  gitFetchTool,
  gitCheckoutTool,
  gitCommitTool,
  gitMergeTool,
  gitMergeAbortTool,
  gitPushTool,
} from "./git.js";
import { createPullRequestTool } from "./github.js";
import { runTestsTool } from "./tests.js";
import { browserCheckTool } from "./playwright.js";
import type { ToolDefinition } from "./types.js";

export const allTools: ToolDefinition[] = [
  readFileTool,
  listDirTool,
  writeFileTool,
  editFileTool,
  runShellTool,
  gitStatusTool,
  gitDiffTool,
  gitCreateBranchTool,
  gitFetchTool,
  gitCheckoutTool,
  gitCommitTool,
  gitMergeTool,
  gitMergeAbortTool,
  gitPushTool,
  createPullRequestTool,
  runTestsTool,
  browserCheckTool,
];

export const toolsByName = new Map(allTools.map((t) => [t.spec.name, t]));

export type { ToolDefinition, ToolContext } from "./types.js";
