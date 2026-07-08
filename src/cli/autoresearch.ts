import { resolve } from "node:path";
import { Command } from "commander";
import { assertPolarisDevContext } from "../autoresearch/dev-gate.js";
import { scoreRun } from "../autoresearch/score.js";
import { loadDiagnosisReport, buildProposals } from "../autoresearch/proposal.js";
import { routeProposals } from "../autoresearch/routing.js";

export interface SolCommandOptions {
  repoRoot: string;
}

/** @deprecated Use {@link SolCommandOptions}. */
export type AutoresearchCommandOptions = SolCommandOptions;

export function createSolCommand(options: SolCommandOptions): Command {
  const repoRoot = options.repoRoot;

  const sol = new Command("sol")
    .alias("autoresearch")
    .description(
      "Self-Optimization Loop (SOL) tools — autoresearch compatibility alias (dev-gated — Polaris development context only)",
    )
    .showHelpAfterError()
    .showSuggestionAfterError();

  sol
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
          `sol score error: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exit(1);
      }
    });

  sol
    .command("propose <diagnosis-file>")
    .description(
      "File Linear improvement proposals from a diagnosis report (dev-gated — never auto-applied)",
    )
    .option("-r, --repo-root <path>", "Repository root", repoRoot)
    .option("--team <team>", "Linear team name or ID to file issues in", "Polaris")
    .option("--dry-run", "Log what would be created without calling Linear")
    .option("--json", "Output raw JSON (default: pretty-printed)")
    .action(
      async (
        diagnosisFile: string,
        cmdOptions: { repoRoot: string; team: string; dryRun?: boolean; json?: boolean },
      ) => {
        const root = resolve(cmdOptions.repoRoot ?? repoRoot);
        try {
          assertPolarisDevContext(root);
        } catch (err) {
          process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
          process.exit(1);
        }

        let report;
        try {
          report = loadDiagnosisReport(resolve(diagnosisFile));
        } catch (err) {
          process.stderr.write(
            `sol propose: invalid diagnosis file: ${err instanceof Error ? err.message : String(err)}\n`,
          );
          process.exit(1);
        }

        const proposals = buildProposals(report);
        if (proposals.length === 0) {
          process.stdout.write("No failed gates with fix zone mappings — nothing to propose.\n");
          process.exit(0);
        }

        const apiKey = process.env["LINEAR_API_KEY"];
        if (!apiKey && !cmdOptions.dryRun) {
          process.stderr.write(
            "sol propose: LINEAR_API_KEY environment variable is required.\n",
          );
          process.exit(1);
        }

        try {
          const result = await routeProposals(proposals, {
            apiKey: apiKey ?? "",
            teamKey: cmdOptions.team,
            dryRun: cmdOptions.dryRun,
          });
          const output = cmdOptions.json
            ? JSON.stringify(result)
            : JSON.stringify(result, null, 2);
          process.stdout.write(`${output}\n`);
          if (result.total_errors > 0) {
            process.exit(1);
          }
        } catch (err) {
          process.stderr.write(
            `sol propose error: ${err instanceof Error ? err.message : String(err)}\n`,
          );
          process.exit(1);
        }
      },
    );

  return sol;
}

/** @deprecated Use {@link createSolCommand}. */
export const createAutoresearchCommand = createSolCommand;
