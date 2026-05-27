import { Command } from "commander";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { runLoopContinue } from "./continue.js";
import { runLoopResume } from "./resume.js";
import { runLoopStatus } from "./status.js";
import { runLoopAbort } from "./abort.js";
import { runLoopDispatch } from "./dispatch.js";
import type { ExecutionAdapterMode } from "./execution-adapter.js";

export interface LoopCommandHandlers {
  runLoopContinue?: typeof runLoopContinue;
  runLoopResume?: typeof runLoopResume;
  runLoopStatus?: typeof runLoopStatus;
  runLoopAbort?: typeof runLoopAbort;
  runLoopDispatch?: typeof runLoopDispatch;
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
  const repoRootDefault = handlers.repoRoot ?? process.cwd();
  const loop = new Command("loop")
    .description("Polaris loop commands: status is safe/read-only; continue is mutating")
    .showHelpAfterError()
    .showSuggestionAfterError();
  loop.action(() => failMissingSubcommand(loop, "polaris loop"));

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

  return loop;
}
