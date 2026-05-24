import { Command } from "commander";
import { join } from "node:path";
import { runLoopContinue } from "./continue.js";
import { runLoopResume } from "./resume.js";
import { runLoopStatus } from "./status.js";
import { runLoopAbort } from "./abort.js";
import type { ExecutionAdapterMode } from "./execution-adapter.js";

export function createLoopCommand(): Command {
  const loop = new Command("loop").description("Polaris loop commands");

  loop
    .command("continue")
    .description(
      "Checkpoint current session state and generate next-session bootstrap packet",
    )
    .option("-r, --repo-root <path>", "Repository root", process.cwd())
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
      const stateFile =
        options.stateFile ?? join(repoRoot, ".polaris", "runs", "current-state.json");
      runLoopContinue({ stateFile, repoRoot, adapter: options.adapter, allowAnalyzeChildren: options.allowAnalyzeChildren });
    });

  loop
    .command("resume [run_id]")
    .description("Resume a session from a bootstrap packet, verifying branch and state integrity")
    .option("-r, --repo-root <path>", "Repository root", process.cwd())
    .option("--state-file <path>", "Override path to current-state.json")
    .action((runId: string | undefined, options: { repoRoot: string; stateFile?: string }) => {
      runLoopResume({ runId, repoRoot: options.repoRoot, stateFile: options.stateFile });
    });

  loop
    .command("status")
    .description("Print current loop run state summary")
    .option("-r, --repo-root <path>", "Repository root", process.cwd())
    .option("--state-file <path>", "Override path to current-state.json")
    .option("--json", "Emit JSON output instead of human-readable text")
    .action((options: { repoRoot: string; stateFile?: string; json?: boolean }) => {
      runLoopStatus({
        repoRoot: options.repoRoot,
        stateFile: options.stateFile,
        json: options.json,
      });
    });

  loop
    .command("abort [reason]")
    .description("Record a blocker, set status to blocked, and halt cleanly")
    .option("-r, --repo-root <path>", "Repository root", process.cwd())
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
        runLoopAbort({
          reason,
          childId: options.child,
          repoRoot: options.repoRoot,
          stateFile: options.stateFile,
        });
      },
    );

  return loop;
}
