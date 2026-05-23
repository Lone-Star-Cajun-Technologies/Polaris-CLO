import { Command } from "commander";
import { join } from "node:path";
import { runLoopContinue } from "./continue.js";

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
    .action((options: { repoRoot: string; stateFile?: string }) => {
      const repoRoot = options.repoRoot;
      const stateFile =
        options.stateFile ?? join(repoRoot, ".polaris", "runs", "current-state.json");
      runLoopContinue({ stateFile, repoRoot });
    });

  return loop;
}
