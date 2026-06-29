import { resolve } from "node:path";
import { Command } from "commander";
import { assertPolarisDevContext } from "../autoresearch/dev-gate.js";
import { scoreRun } from "../autoresearch/score.js";

export interface AutoresearchCommandOptions {
  repoRoot: string;
}

export function createAutoresearchCommand(options: AutoresearchCommandOptions): Command {
  const repoRoot = options.repoRoot;

  const autoresearch = new Command("autoresearch")
    .description("Autoresearch tools (dev-gated — Polaris development context only)")
    .showHelpAfterError()
    .showSuggestionAfterError();

  autoresearch
    .command("score <run-id>")
    .description(
      "Score a completed Polaris run against the binary gate scorecard and output a diagnosis report",
    )
    .option("-r, --repo-root <path>", "Repository root", repoRoot)
    .option("--json", "Output raw JSON (default: pretty-printed)")
    .action((runId: string, cmdOptions: { repoRoot: string; json?: boolean }) => {
      const root = resolve(cmdOptions.repoRoot ?? repoRoot);
      try {
        assertPolarisDevContext(root);
      } catch (err) {
        process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }

      try {
        const report = scoreRun(root, runId);
        const output = cmdOptions.json
          ? JSON.stringify(report)
          : JSON.stringify(report, null, 2);
        process.stdout.write(`${output}\n`);
      } catch (err) {
        process.stderr.write(
          `autoresearch score error: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exit(1);
      }
    });

  return autoresearch;
}
