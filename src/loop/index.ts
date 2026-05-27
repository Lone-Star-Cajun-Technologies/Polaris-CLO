import { Command } from "commander";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { runLoopContinue } from "./continue.js";
import { runLoopResume } from "./resume.js";
import { runLoopStatus } from "./status.js";
import { runLoopAbort } from "./abort.js";
import { runLoopDispatch } from "./dispatch.js";
import { runParentLoop } from "./parent.js";
import { runLoopBootstrapInit, type BootstrapInitOptions } from "./run-bootstrap.js";
import type { ExecutionAdapterMode } from "./execution-adapter.js";

export interface LoopCommandHandlers {
  runLoopContinue?: typeof runLoopContinue;
  runLoopResume?: typeof runLoopResume;
  runLoopStatus?: typeof runLoopStatus;
  runLoopAbort?: typeof runLoopAbort;
  runLoopDispatch?: typeof runLoopDispatch;
  runParentLoop?: typeof runParentLoop;
  runLoopBootstrapInit?: typeof runLoopBootstrapInit;
  repoRoot?: string;
}

function defaultStateFile(repoRoot: string, stateFile?: string): string {
  if (stateFile) {
    return stateFile;
  }

  const newPath = join(repoRoot, ".taskchain_artifacts", "polaris-run", "current-state.json");
  const legacyPath = join(repoRoot, ".polaris", "runs", "current-state.json");

  // If the new path exists, use it
  if (existsSync(newPath)) {
    return newPath;
  }

  // If the legacy path exists, use it
  if (existsSync(legacyPath)) {
    return legacyPath;
  }

  // Neither exists, return the new path so callers can create it
  return newPath;
}

function failMissingSubcommand(command: Command, commandName: string): never {
  const unknownSubcommand = command.args[0];
  const message = unknownSubcommand
    ? `error: unknown command '${unknownSubcommand}' for '${commandName}'. Run '${commandName} --help'.`
    : `error: missing command for '${commandName}'. Run '${commandName} --help'.`;
  command.error(message, {
    code: "commander.missingCommand",
    exitCode: 1,
  });
}

export function createLoopCommand(handlers: LoopCommandHandlers = {}): Command {
  const continueHandler = handlers.runLoopContinue ?? runLoopContinue;
  const resumeHandler = handlers.runLoopResume ?? runLoopResume;
  const statusHandler = handlers.runLoopStatus ?? runLoopStatus;
  const abortHandler = handlers.runLoopAbort ?? runLoopAbort;
  const dispatchHandler = handlers.runLoopDispatch ?? runLoopDispatch;
  const parentHandler = handlers.runParentLoop ?? runParentLoop;
  const bootstrapHandler = handlers.runLoopBootstrapInit ?? runLoopBootstrapInit;
  const repoRootDefault = handlers.repoRoot ?? process.cwd();
  const loop = new Command("loop")
    .description("Polaris loop commands: status is safe/read-only; continue is mutating")
    .showHelpAfterError()
    .showSuggestionAfterError();
  loop.action(() => failMissingSubcommand(loop, "polaris loop"));

  loop
    .command("run")
    .description("mutating: run the automated parent loop for a cluster")
    .argument("<cluster-id>", "Parent cluster ID")
    .option("-r, --repo-root <path>", "Repository root", repoRootDefault)
    .option("--state-file <path>", "Path to current-state.json")
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
        clusterId: string,
        options: {
          repoRoot: string;
          stateFile?: string;
          adapter?: string;
          provider?: string;
          dryRun?: boolean;
          allowAnalyzeChildren?: boolean;
        },
      ) => {
        const repoRoot = options.repoRoot;
        const stateFile = defaultStateFile(repoRoot, options.stateFile);
        const result = await parentHandler({
          stateFile,
          repoRoot,
          adapter: options.adapter,
          provider: options.provider,
          dryRun: options.dryRun,
          allowAnalyzeChildren: options.allowAnalyzeChildren,
        });
        const summary = [
          `Polaris parent loop halted: ${result.haltReason}`,
          `Cluster: ${clusterId}`,
          `Children dispatched: ${result.childrenDispatched}`,
          result.haltingChild ? `Halting child: ${result.haltingChild}` : undefined,
          result.message,
        ].filter((line): line is string => Boolean(line)).join("\n");

        if (result.haltReason === "cluster-complete") {
          process.stdout.write(`${summary}\n`);
          return;
        }

        process.stderr.write(`${summary}\n`);
        process.exit(1);
      },
    );

  loop
    .command("continue")
    .description(
      "mutating: checkpoint state and generate next-session bootstrap packet; not a smoke test",
    )
    .option("-r, --repo-root <path>", "Repository root", repoRootDefault)
    .option(
      "--state-file <path>",
      "Path to current-state.json",
    )
    .option(
      "--adapter <mode>",
      "Execution adapter: agent-subtask, terminal-cli, ci, ssh, remote-worker, cross-agent",
    )
    .option(
      "--provider <provider>",
      "AI provider for the next worker session (e.g. claude, openai, gemini)",
    )
    .option(
      "--allow-analyze-children",
      "Allow analyze-type children to be dispatched (overrides budget.allow_analyze_children)",
    )
    .action((options: { repoRoot: string; stateFile?: string; adapter?: ExecutionAdapterMode; provider?: string; allowAnalyzeChildren?: boolean }) => {
      const repoRoot = options.repoRoot;
      const stateFile = defaultStateFile(repoRoot, options.stateFile);
      continueHandler({ stateFile, repoRoot, adapter: options.adapter, provider: options.provider, allowAnalyzeChildren: options.allowAnalyzeChildren });
    });

  loop
    .command("dispatch")
    .description("mutating: claim the next open child and emit a compiled WorkerPacket")
    .option("-r, --repo-root <path>", "Repository root", repoRootDefault)
    .option("--state-file <path>", "Override path to current-state.json")
    .option("--child <id>", "Open child issue ID to dispatch instead of the first open child")
    .action((options: { repoRoot: string; stateFile?: string; child?: string }) => {
      dispatchHandler({
        repoRoot: options.repoRoot,
        stateFile: defaultStateFile(options.repoRoot, options.stateFile),
        childId: options.child,
      });
    });

  loop
    .command("resume [run_id]")
    .description("mutating: resume from a bootstrap packet after branch/state integrity checks")
    .option("-r, --repo-root <path>", "Repository root", repoRootDefault)
    .option("--state-file <path>", "Override path to current-state.json")
    .action((runId: string | undefined, options: { repoRoot: string; stateFile?: string }) => {
      resumeHandler({
        runId,
        repoRoot: options.repoRoot,
        stateFile: defaultStateFile(options.repoRoot, options.stateFile),
      });
    });

  loop
    .command("status")
    .description("safe/read-only: print current loop run state summary")
    .option("-r, --repo-root <path>", "Repository root", repoRootDefault)
    .option("--state-file <path>", "Override path to current-state.json")
    .option("--json", "Emit JSON output instead of human-readable text")
    .action((options: { repoRoot: string; stateFile?: string; json?: boolean }) => {
      statusHandler({
        repoRoot: options.repoRoot,
        stateFile: defaultStateFile(options.repoRoot, options.stateFile),
        json: options.json,
      });
    });

  loop
    .command("abort [reason]")
    .description("mutating: record a blocker, set status to blocked, and halt cleanly")
    .option("-r, --repo-root <path>", "Repository root", repoRootDefault)
    .option("--state-file <path>", "Override path to current-state.json")
    .option("--child <id>", "Child issue ID the blocker is associated with")
    .action(
      (
        reason: string | undefined,
        options: { repoRoot: string; stateFile?: string; child?: string },
      ) => {
        if (!reason) {
          process.stderr.write("Error: reason is required\n");
          process.exit(1);
        }
        abortHandler({
          reason,
          childId: options.child,
          repoRoot: options.repoRoot,
          stateFile: defaultStateFile(options.repoRoot, options.stateFile),
        });
      },
    );

  loop
    .command("bootstrap")
    .description(
      "mutating: initialize a new run — the ONLY valid way to create run state. " +
      "Parent sessions may not hand-create current-state.json; this command issues " +
      "a bootstrap seal that dispatch and run commands verify before proceeding.",
    )
    .requiredOption("--cluster-id <id>", "Parent cluster issue ID (e.g. POL-100)")
    .requiredOption(
      "--children <csv>",
      "Comma-separated ordered list of child issue IDs to execute (e.g. POL-101,POL-102)",
    )
    .option("-r, --repo-root <path>", "Repository root", repoRootDefault)
    .option("--state-file <path>", "Override path to write current-state.json")
    .option("--run-id <id>", "Override auto-generated run ID")
    .option(
      "--session-type <type>",
      "Session type: analyze | implement (default: implement)",
      "implement",
    )
    .option("--max-children <n>", "Max children per dispatch session (default: 1)", "1")
    .option("--branch <name>", "Git branch for this run")
    .option("--artifact-dir <path>", "Override artifact directory")
    .action(
      (options: {
        clusterId: string;
        children: string;
        repoRoot: string;
        stateFile?: string;
        runId?: string;
        sessionType: string;
        maxChildren: string;
        branch?: string;
        artifactDir?: string;
      }) => {
        const openChildren = options.children
          .split(",")
          .map((c) => c.trim())
          .filter(Boolean);

        const parsedMaxChildren = parseInt(options.maxChildren, 10);
        const maxChildrenPerSession = Number.isInteger(parsedMaxChildren) && parsedMaxChildren > 0
          ? parsedMaxChildren
          : 1;

        const bootstrapOptions: BootstrapInitOptions = {
          clusterId: options.clusterId,
          runId: options.runId,
          openChildren,
          stateFile: defaultStateFile(options.repoRoot, options.stateFile),
          repoRoot: options.repoRoot,
          branch: options.branch,
          sessionType: options.sessionType === "analyze" ? "analyze" : "implement",
          maxChildrenPerSession,
          artifactDir: options.artifactDir,
        };

        bootstrapHandler(bootstrapOptions);
      },
    );

  return loop;
}
