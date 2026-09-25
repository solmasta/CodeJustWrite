#!/usr/bin/env node
import { config as loadDotenv } from "dotenv";
import path from "node:path";
import { Command } from "commander";
import { loadConfig } from "@codejustwrite/core";
import { runRepl } from "./cli/repl.js";

loadDotenv({ path: path.resolve(process.cwd(), ".env"), quiet: true });

const program = new Command();

program
  .name("cjw")
  .description(
    "CodeJustWrite — terminal AI coding agent running fully locally (Ollama-compatible) with git, PR automation, and a testing sandbox."
  )
  .option("--model <name>", "Model to start with (default: qwen2.5-coder:14b)")
  .action(async (opts: { model?: string }) => {
    const config = loadConfig();
    if (opts.model) config.model = opts.model;
    await runRepl(config);
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
