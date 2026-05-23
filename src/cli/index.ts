#!/usr/bin/env node
import { Command } from "commander";
import { getVersion } from "./version.js";

const program = new Command();

program
  .name("polaris")
  .description("Polaris — AI-assisted repository governance")
  .version(getVersion(), "-V, --version", "Show Polaris version");

program.parse();
