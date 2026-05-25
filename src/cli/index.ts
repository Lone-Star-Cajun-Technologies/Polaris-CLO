#!/usr/bin/env node
import { Command } from "commander";
import { getVersion } from "./version.js";
import { loadConfig, PolarisConfigError } from "../config/loader.js";
import { createMapCommand } from "../map/index.js";
import { createLoopCommand } from "../loop/index.js";
import { createFinalizeCommand } from "../finalize/index.js";
import { createDocsCommand, createDoctrineCommand } from "../docs/index.js";

const program = new Command();

program
  .name("polaris")
  .description("Polaris — AI-assisted repository governance")
  .version(getVersion(), "-V, --version", "Show Polaris version");

program
  .command("config")
  .description("Polaris configuration commands")
  .addCommand(
    new Command("show")
      .description("Show resolved Polaris configuration")
      .option("-r, --repo-root <path>", "Repository root", process.cwd())
      .action((options) => {
        try {
          const config = loadConfig(options.repoRoot);
          console.log(JSON.stringify(config, null, 2));
        } catch (err) {
          if (err instanceof PolarisConfigError) {
            console.error(err.message);
            process.exit(1);
          }
          throw err;
        }
      }),
  );

program.addCommand(createMapCommand());
program.addCommand(createLoopCommand());
program.addCommand(createFinalizeCommand());
program.addCommand(createDocsCommand());
program.addCommand(createDoctrineCommand());

program
  .command("run <issue>")
  .description("Run a Polaris cluster for a given Linear issue")
  .option("-r, --repo-root <path>", "Repository root", process.cwd())
  .option("--provider <provider>", "AI provider for worker sessions (e.g. claude, openai, gemini)")
  .option("--dry-run", "Print the plan without executing")
  .action(() => {
    console.log("not yet implemented");
  });

program.parse();
