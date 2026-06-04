#!/usr/bin/env node

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { Command } from "commander";
import { getVersion } from "./version.js";
import { createLoopCommand } from "../loop/index.js";
import { runLoopContinue } from "../loop/continue.js";
import { runLoopStatus } from "../loop/status.js";
import { runParentLoop } from "../loop/parent.js";
import { runLoopBootstrapInit } from "../loop/run-bootstrap.js";
import { ensureClusterRunState } from "../loop/run-preflight.js";
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
import { SpecAdapter } from "../tracker/adapters/spec/index.js";

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

function assertSpecPath(specPath: string | undefined, commandName: string): string {
  if (!specPath || specPath.trim().length === 0) {
    throw new Error(`${commandName} requires a spec path`);
  }
  return resolve(specPath);
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

  program
    .command("analyze")
    .description("analyze entrypoints")
    .addCommand(
      new Command("spec")
        .description("safe/read-only: load a local spec markdown file into a local execution graph")
        .argument("<path>", "Path to markdown spec file")
        .option("-r, --repo-root <path>", "Repository root", repoRoot)
        .action(async (specPath: string, commandOptions: { repoRoot: string }) => {
          const resolvedRepoRoot = resolve(commandOptions.repoRoot ?? repoRoot);
          const resolvedSpecPath = assertSpecPath(specPath, "polaris analyze spec");
          const graph = await new SpecAdapter().syncIn(resolvedSpecPath);
          const clusterId = graph.fullGraph.activeCluster;
          const writtenPath = await graph.save(clusterId, resolvedRepoRoot);
          process.stdout.write(
            JSON.stringify(
              {
                cluster_id: clusterId,
                source_type: graph.fullGraph.source.type,
                children: graph.getActiveCluster().children,
                clusters_file: writtenPath,
              },
              null,
              2,
            ) + "\n",
          );
        }),
    );

  program
    .command("run")
    .description("run entrypoints")
    .addCommand(
      new Command("spec")
        .description("mutating: ingest a local spec markdown file and run normal parent bootstrap/dispatch")
        .argument("<path>", "Path to markdown spec file")
        .option("-r, --repo-root <path>", "Repository root", repoRoot)
        .option("--state-file <path>", "Override path to current-state.json")
        .option(
          "--adapter <mode>",
          "Execution adapter: agent-subtask, terminal-cli, ci, ssh, remote-worker, cross-agent",
        )
        .option(
          "--provider <name>",
          "AI provider for worker dispatch (e.g. claude, openai, gemini)",
        )
        .option("--dry-run", "Log dispatches without executing workers")
        .option(
          "--allow-analyze-children",
          "Allow analyze-type children to be dispatched (overrides budget.allow_analyze_children)",
        )
        .action(
          async (
            specPath: string,
            commandOptions: {
              repoRoot: string;
              stateFile?: string;
              adapter?: string;
              provider?: string;
              dryRun?: boolean;
              allowAnalyzeChildren?: boolean;
            },
          ) => {
            const resolvedRepoRoot = resolve(commandOptions.repoRoot ?? repoRoot);
            const resolvedSpecPath = assertSpecPath(specPath, "polaris run spec");
            const graph = await new SpecAdapter().syncIn(resolvedSpecPath);
            const clusterId = graph.fullGraph.activeCluster;
            await graph.save(clusterId, resolvedRepoRoot);

            const stateFile = resolveStateFile(resolvedRepoRoot, commandOptions.stateFile);
            await ensureClusterRunState({
              clusterId,
              stateFile,
              repoRoot: resolvedRepoRoot,
              bootstrapHandler: runLoopBootstrapInit,
            });
            const result = await runParentLoop({
              stateFile,
              repoRoot: resolvedRepoRoot,
              adapter: commandOptions.adapter,
              provider: commandOptions.provider,
              dryRun: commandOptions.dryRun,
              allowAnalyzeChildren: commandOptions.allowAnalyzeChildren,
            });

            const summary = [
              `Polaris parent loop halted: ${result.haltReason}`,
              `Cluster: ${clusterId}`,
              `Children dispatched: ${result.childrenDispatched}`,
              result.haltingChild ? `Halting child: ${result.haltingChild}` : undefined,
              result.message,
            ]
              .filter((line): line is string => Boolean(line))
              .join("\n");

            if (result.haltReason === "cluster-complete") {
              process.stdout.write(`${summary}\n`);
              return;
            }

            process.stderr.write(`${summary}\n`);
            process.exit(1);
          },
        ),
    );

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
