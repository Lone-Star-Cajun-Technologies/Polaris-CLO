import { Command } from "commander";
import { join } from "node:path";
import { runLoopContinue } from "./continue.js";
import { runLoopResume } from "./resume.js";
import { runLoopStatus } from "./status.js";
import { runLoopAbort } from "./abort.js";
import type { ExecutionAdapterMode } from "./execution-adapter.js";

export interface LoopCommandHandlers {
  runLoopContinue?: typeof runLoopContinue;
  runLoopResume?: typeof runLoopResume;
  runLoopStatus?: typeof runLoopStatus;
  runLoopAbort?: typeof runLoopAbort;
  repoRoot?: string;
}

function defaultStateFile(repoRoot: string, stateFile?: string): string {
  return (
    stateFile ??
    join(repoRoot, ".taskchain_artifacts", "polaris-run", "current-state.json")
  );
}

export function createLoopCommand(handlers: LoopCommandHandlers = {}): Command {
  const continueHandler = handlers.runLoopContinue ?? runLoopContinue;
  const resumeHandler = handlers.runLoopResume ?? runLoopResume;
  const statusHandler = handlers.runLoopStatus ?? runLoopStatus;
  const abortHandler = handlers.runLoopAbort ?? runLoopAbort;
  const repoRootDefault = handlers.repoRoot ?? process.cwd();
  const loop = new Command("loop").description("Polaris loop commands");

  loop
    .command("continue")
    .description(
      "Checkpoint current session state and generate next-session bootstrap packet",
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
    .command("resume [run_id]")
    .description("Resume a session from a bootstrap packet, verifying branch and state integrity")
    .option("-r, --repo-root <path>", "Repository root", repoRootDefault)
    .option("--state-file <path>", "Override path to current-state.json")
    .action((runId: string | undefined, options: { repoRoot: string; stateFile?: string }) => {
      resumeHandler({ runId, repoRoot: options.repoRoot, stateFile: options.stateFile });
    });

  loop
    .command("status")
    .description("Print current loop run state summary")
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
    .description("Record a blocker, set status to blocked, and halt cleanly")
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
          stateFile: options.stateFile,
        });
      },
    );

  return loop;
}
