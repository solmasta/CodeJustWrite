#!/usr/bin/env node
import { Command } from "commander";
import { loadConfig } from "./config/config.js";
import { runRepl } from "./cli/repl.js";

const program = new Command();

program
  .name("cjw")
  .description(
    "CodeJustWrite — terminal AI coding agent (DeepInfra/OpenAI) with git, PR automation, and a testing sandbox."
  )
  .option("--provider <name>", "LLM provider to start with: openai | deepinfra")
  .option("--model <name>", "Model to start with")
  .action(async (opts: { provider?: string; model?: string }) => {
    const config = loadConfig();
    if (opts.provider) config.provider = opts.provider as typeof config.provider;
    if (opts.model) config.model = opts.model;
    await runRepl(config);
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
