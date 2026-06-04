#!/usr/bin/env node

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { Command } from "commander";
import { getVersion } from "./version.js";
import { createLoopCommand } from "../loop/index.js";
import { runLoopContinue } from "../loop/continue.js";
import { runLoopStatus } from "../loop/status.js";
import { createMapCommand } from "../map/index.js";
import { runMapQuery } from "../map/query.js";
import { createFinalizeCommand } from "../finalize/index.js";
import { runFinalize } from "../finalize/index.js";
import { createRunsCommand } from "../runs/index.js";
import { createInitCommand, runInit } from "./init.js";
import { createDocsCommand, createDoctrineCommand } from "../smartdocs-engine/index.js";
import { createConfigCommand, runConfigShow } from "../config/show.js";
import { installCliSubtaskBridge } from "../loop/adapters/cli-subtask-bridge.js";
import { assertFinalizeEvidenceOrThrow } from "../loop/finalize-evidence.js";

import { createTrackerCommand } from "./tracker.js";
import { createWorkerCommand } from "./worker.js";
import { createSkillCommand } from "../skill-packet/index.js";
import { createLibrarianCommand } from "./librarian.js";

export interface PolarisCommandHandlers {
  runLoopStatus?: typeof runLoopStatus;
  runLoopContinue?: typeof runLoopContinue;
  runMapQuery?: typeof runMapQuery;
  runFinalize?: typeof runFinalize;
  runInit?: typeof runInit;
  runConfigShow?: typeof runConfigShow;
}

export interface PolarisCommandOptions extends PolarisCommandHandlers {
  repoRoot?: string;
}

function resolveStateFile(repoRoot: string, explicit?: string): string {
  if (explicit) return resolve(explicit);

  const taskchainPath = join(repoRoot, ".taskchain_artifacts", "polaris-run", "current-state.json");
  const polarisPath = join(repoRoot, ".polaris", "runs", "current-state.json");
  if (existsSync(taskchainPath)) return taskchainPath;
  if (existsSync(polarisPath)) return polarisPath;
  return taskchainPath;
}

export function createPolarisCommand(options: PolarisCommandOptions = {}): Command {
  const repoRoot = options.repoRoot ?? resolve(process.cwd());
  installCliSubtaskBridge(repoRoot);
  const statusHandler = options.runLoopStatus ?? runLoopStatus;
  const finalizeHandler = options.runFinalize ?? (async (finalizeOptions: Parameters<typeof runFinalize>[0]) => {
    assertFinalizeEvidenceOrThrow(finalizeOptions.repoRoot, finalizeOptions.stateFile);
    await runFinalize(finalizeOptions);
  });

  const program = new Command("polaris")
    .description("Polaris taskchain operator CLI")
    .version(getVersion())
    .showHelpAfterError()
    .showSuggestionAfterError();

  program
    .command("status")
    .description("safe/read-only: print current loop run state summary")
    .option("--state-file <path>", "Override path to current-state.json")
    .option("--json", "Emit JSON output instead of human-readable text")
    .action((commandOptions: { stateFile?: string; json?: boolean }) => {
      statusHandler({
        repoRoot,
        stateFile: resolveStateFile(repoRoot, commandOptions.stateFile),
        json: commandOptions.json,
      });
    });

  program.addCommand(
    createLoopCommand({
      repoRoot,
      runLoopStatus: statusHandler,
      runLoopContinue: options.runLoopContinue,
    }),
  );

  program.addCommand(
    createMapCommand({
      repoRoot,
      runMapQuery: options.runMapQuery,
    }),
  );

  program.addCommand(
    createFinalizeCommand({
      repoRoot,
      runFinalize: finalizeHandler,
    }),
  );

  program.addCommand(createRunsCommand({ repoRoot }));

  program.addCommand(
    createInitCommand({
      repoRoot,
      detectProviders: undefined,
    }),
  );

  program.addCommand(createDocsCommand({ repoRoot }));
  program.addCommand(createDoctrineCommand());

  program.addCommand(
    createConfigCommand({
      repoRoot,
      runConfigShow: options.runConfigShow,
    }),
  );

  program.addCommand(
    createTrackerCommand({
      repoRoot,
    }),
  );

  program.addCommand(
    createWorkerCommand({
      repoRoot,
    }),
  );

  program.addCommand(
    createSkillCommand({
      repoRoot,
    }),
  );

  program.addCommand(
    createLibrarianCommand({
      repoRoot,
    }),
  );

  return program;
}

if (require.main === module) {
  createPolarisCommand().parseAsync(process.argv).catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
