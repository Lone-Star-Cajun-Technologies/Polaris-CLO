#!/usr/bin/env node
import { Command } from "commander";
import { getVersion } from "./version.js";
import { loadConfig, PolarisConfigError } from "../config/loader.js";
import { createMapCommand } from "../map/index.js";
import { createLoopCommand } from "../loop/index.js";

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

program.parse();
