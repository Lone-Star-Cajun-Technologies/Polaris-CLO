#!/usr/bin/env node

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseCliArgs } from "./args.js";
import { runLoopStatus } from "../loop/status.js";
import { runLoopContinue } from "../loop/continue.js";

const repoRoot = resolve(process.cwd());
const [, , cmd, ...rest] = process.argv;
const { flags, positional } = parseCliArgs(rest);

function findStateFile(): string {
  const taskchainPath = join(repoRoot, ".taskchain_artifacts", "polaris-run", "current-state.json");
  const polarisPath = join(repoRoot, ".polaris", "runs", "current-state.json");
  if (flags["state-file"] && typeof flags["state-file"] === "string") {
    return resolve(flags["state-file"]);
  }
  if (existsSync(taskchainPath)) return taskchainPath;
  if (existsSync(polarisPath)) return polarisPath;
  return taskchainPath; // let runLoopStatus report the missing-file error
}

function usage(): void {
  console.log("Usage: polaris <command> [subcommand] [options]");
  console.log("");
  console.log("Commands:");
  console.log("  status                       Print current loop state");
  console.log("  loop status                  Print current loop state");
  console.log("  loop continue                Advance the current taskchain loop");
  console.log("  run                          Start or resume a Polaris run");
  console.log("");
  console.log("Options:");
  console.log("  --state-file <path>          Path to current-state.json");
  console.log("  --json                       Output as JSON");
  console.log("  --dry-run                    Dry-run mode (no mutations)");
  process.exit(1);
}

switch (cmd) {
  case "run":
    console.log("[polaris] run — not yet implemented (Cluster 4)");
    break;

  case "loop": {
    const sub = positional[0];
    if (sub === "continue") {
      runLoopContinue({
        stateFile: findStateFile(),
        repoRoot,
      });
    } else if (sub === "status") {
      runLoopStatus({
        stateFile: findStateFile(),
        repoRoot,
        json: flags["json"] === true,
      });
    } else {
      console.error(`Unknown loop subcommand: ${sub ?? "(none)"}`);
      usage();
    }
    break;
  }

  case "status":
    runLoopStatus({
      stateFile: findStateFile(),
      repoRoot,
      json: flags["json"] === true,
    });
    break;

  default:
    if (!cmd) {
      usage();
    } else {
      console.error(`Unknown command: ${cmd}`);
      usage();
    }
}
