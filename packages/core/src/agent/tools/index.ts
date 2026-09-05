import { readFileTool, listDirTool, writeFileTool, editFileTool, deleteFileTool, searchFilesTool } from "./fs.js";
import { runShellTool } from "./shell.js";
import {
  gitStatusTool,
  gitDiffTool,
  gitLogTool,
  gitStashTool,
  gitStashPopTool,
  gitCreateBranchTool,
  gitFetchTool,
  gitCheckoutTool,
  gitCommitTool,
  gitMergeTool,
  gitMergeAbortTool,
  gitPushTool,
} from "./git.js";
import { createPullRequestTool, mergePullRequestTool, getPullRequestStatusTool, githubExtraTools } from "./github.js";
import { runTestsTool } from "./tests.js";
import { browserCheckTool } from "./playwright.js";
import { renderTools } from "./render.js";
import type { ToolDefinition } from "./types.js";

export const allTools: ToolDefinition[] = [
  readFileTool,
  listDirTool,
  writeFileTool,
  editFileTool,
  deleteFileTool,
  searchFilesTool,
  runShellTool,
  gitStatusTool,
  gitDiffTool,
  gitLogTool,
  gitStashTool,
  gitStashPopTool,
  gitCreateBranchTool,
  gitFetchTool,
  gitCheckoutTool,
  gitCommitTool,
  gitMergeTool,
  gitMergeAbortTool,
  gitPushTool,
  createPullRequestTool,
  mergePullRequestTool,
  getPullRequestStatusTool,
  ...githubExtraTools,
  runTestsTool,
  browserCheckTool,
  ...renderTools,
];

export const toolsByName = new Map(allTools.map((t) => [t.spec.name, t]));

export type { ToolDefinition, ToolContext } from "./types.js";
