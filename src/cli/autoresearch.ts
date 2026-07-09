import { resolve } from "node:path";
import { Command } from "commander";
import { assertPolarisDevContext } from "../autoresearch/dev-gate.js";
import { scoreRun, loadRunArtifacts } from "../autoresearch/score.js";
import { loadDiagnosisReport, buildProposals } from "../autoresearch/proposal.js";
import { routeProposals } from "../autoresearch/routing.js";
import { aggregateSolEvidence } from "../autoresearch/sol-evidence-loader.js";
import { computeSolScoreReport } from "../autoresearch/sol-scorer.js";
import { appendSnapshot, loadSnapshots, buildSnapshot } from "../autoresearch/sol-history.js";
import { generateReport, formatReportCli } from "../autoresearch/sol-report.js";
import type { SolReportGroupBy } from "../autoresearch/sol-report.js";
import {
  computeAllScorecards,
} from "../autoresearch/sol-scorecard-calculator.js";
import {
  buildEvaluationRecord,
  writeEvaluationRecord,
  writeScorecardSet,
  writeSolMarkdownReport,
} from "../autoresearch/sol-evaluation-writer.js";
import { renderSolMarkdown } from "../autoresearch/sol-report-renderer.js";
import {
  generateRecommendations,
  recommendationsToProposals,
  formatRecommendationsCli,
  generateQcRecommendations,
} from "../autoresearch/sol-recommendations.js";

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
    .command("score-report <run-id>")
    .description(
      "Compute a SOL score report with diagnostic sub-scores for Foreman and Workers",
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
        const artifacts = loadRunArtifacts(root, runId);
        const evidence = aggregateSolEvidence(artifacts);
        const report = computeSolScoreReport(evidence);
        const output = cmdOptions.json
          ? JSON.stringify(report)
          : JSON.stringify(report, null, 2);
        process.stdout.write(`${output}\n`);
      } catch (err) {
        process.stderr.write(
          `sol score-report error: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exit(1);
      }
    });

  sol
    .command("report <run-id>")
    .description(
      "Generate SOL evaluation artifacts and a human-readable SmartDocs report for a run",
    )
    .option("-r, --repo-root <path>", "Repository root", repoRoot)
    .option("--format <mode>", "Output format: markdown or json", "markdown")
    .option("--json", "Output raw JSON (same as --format json)")
    .option("--no-write", "Skip writing artifact files")
    .action((runId: string, cmdOptions: { repoRoot: string; format: string; json?: boolean; write: boolean }) => {
      const root = resolve(cmdOptions.repoRoot ?? repoRoot);
      if (cmdOptions.format !== "markdown" && cmdOptions.format !== "json") {
        process.stderr.write(
          `sol autoresearch error: invalid --format "${cmdOptions.format}" (expected "markdown" or "json")\n`,
        );
        process.exit(1);
      }
      try {
        assertPolarisDevContext(root);
      } catch (err) {
        process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }

      let artifacts;
      let evidence;
      try {
        artifacts = loadRunArtifacts(root, runId);
        evidence = aggregateSolEvidence(artifacts);
      } catch (err) {
        process.stderr.write(
          `sol autoresearch error: cannot load run artifacts: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exit(1);
      }

      try {
        const report = computeSolScoreReport(evidence);
        const scorecards = computeAllScorecards(evidence);
        const qcRecommendations = generateQcRecommendations(evidence);

        let evaluationPath: string | undefined;
        let scorecardPaths: string[] | undefined;
        let markdownPath: string | undefined;

        const evaluationRecord = buildEvaluationRecord(report);
        const rendered = renderSolMarkdown(evaluationRecord, scorecards, qcRecommendations);

        if (cmdOptions.write) {
          evaluationPath = writeEvaluationRecord(root, report).path;
          scorecardPaths = writeScorecardSet(root, scorecards);
          markdownPath = writeSolMarkdownReport(root, runId, rendered.markdown);
        }

        const outputFormat = cmdOptions.json || cmdOptions.format === "json" ? "json" : "markdown";

        if (outputFormat === "json") {
          const output = JSON.stringify(
            {
              run_id: runId,
              evaluation: evaluationRecord,
              scorecards,
              qc_recommendations: qcRecommendations,
              artifacts: {
                evaluation: evaluationPath,
                scorecards: scorecardPaths,
                markdown: markdownPath,
              },
            },
            null,
            2,
          );
          process.stdout.write(`${output}\n`);
        } else {
          process.stdout.write(rendered.markdown);
        }
      } catch (err) {
        process.stderr.write(
          `sol autoresearch error: ${err instanceof Error ? err.message : String(err)}\n`,
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

  sol
    .command("recommend")
    .description(
      "Generate SOL routing recommendations from historical snapshots (advisory by default; filing is Polaris-dev only)",
    )
    .option("-r, --repo-root <path>", "Repository root", repoRoot)
    .option("--history-path <path>", "Custom history directory (relative to repo root)")
    .option(
      "--group-by <dims>",
      "Comma-separated grouping dimensions (provider,model,role,route,task_type,repo,risk,worker_id,run_id,time_window)",
      "provider,model,role,route,task_type",
    )
    .option("--threshold <n>", "Mean composite threshold below which a recommendation is triggered", "0.7")
    .option("--min-samples <n>", "Minimum snapshots per group before recommending", "2")
    .option("--file", "File review-gated tracker proposals (requires Polaris dev context)")
    .option("--team <team>", "Tracker team name or ID", "Polaris")
    .option("--dry-run", "Show tracker mutations without writing to the tracker")
    .option("--json", "Output raw JSON (default: human-readable)")
    .action(
      async (
        cmdOptions: {
          repoRoot: string;
          historyPath?: string;
          groupBy: string;
          threshold: string;
          minSamples: string;
          file?: boolean;
          team: string;
          dryRun?: boolean;
          json?: boolean;
        },
      ) => {
        const root = resolve(cmdOptions.repoRoot ?? repoRoot);

        let snapshots;
        try {
          snapshots = loadSnapshots(root, cmdOptions.historyPath);
        } catch (err) {
          process.stderr.write(
            `sol recommend error: ${err instanceof Error ? err.message : String(err)}\n`,
          );
          process.exit(1);
        }

        const groupBy = cmdOptions.groupBy.split(",").filter(Boolean) as SolReportGroupBy[];
        const threshold = parseFloat(cmdOptions.threshold) || 0.7;
        const minSamples = parseInt(cmdOptions.minSamples, 10) || 2;

        const report = generateRecommendations(snapshots, { groupBy, threshold, minSamples });

        // Advisory mode: never touches the tracker or filesystem.
        if (!cmdOptions.file) {
          if (cmdOptions.json) {
            process.stdout.write(JSON.stringify(report) + "\n");
          } else {
            process.stdout.write(formatRecommendationsCli(report));
          }
          process.exit(0);
        }

        // Filing mode: Polaris dev context only.
        try {
          assertPolarisDevContext(root);
        } catch (err) {
          process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
          process.exit(1);
        }

        if (report.recommendations.length === 0) {
          process.stdout.write("No underperforming groups — nothing to file.\n");
          process.exit(0);
        }

        const apiKey = process.env["LINEAR_API_KEY"];
        if (!apiKey && !cmdOptions.dryRun) {
          process.stderr.write("sol recommend: LINEAR_API_KEY environment variable is required.\n");
          process.exit(1);
        }

        const proposals = recommendationsToProposals(report.recommendations);
        try {
          const result = await routeProposals(proposals, {
            apiKey: apiKey ?? "",
            teamKey: cmdOptions.team,
            dryRun: cmdOptions.dryRun,
          });
          const output = cmdOptions.json ? JSON.stringify(result) : JSON.stringify(result, null, 2);
          process.stdout.write(`${output}\n`);
          if (result.total_errors > 0) {
            process.exit(1);
          }
        } catch (err) {
          process.stderr.write(
            `sol recommend error: ${err instanceof Error ? err.message : String(err)}\n`,
          );
          process.exit(1);
        }
      },
    );

  // ── history subcommand group ──
  const history = new Command("history")
    .description("SOL historical performance storage and reports");

  history
    .command("save <run-id>")
    .description("Score a run and persist the SOL score snapshot to local history")
    .option("-r, --repo-root <path>", "Repository root", repoRoot)
    .option("--history-path <path>", "Custom history directory (relative to repo root)")
    .action((runId: string, cmdOptions: { repoRoot: string; historyPath?: string }) => {
      const root = resolve(cmdOptions.repoRoot ?? repoRoot);
      try {
        assertPolarisDevContext(root);
      } catch (err) {
        process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }

      try {
        const artifacts = loadRunArtifacts(root, runId);
        const evidence = aggregateSolEvidence(artifacts);
        const report = computeSolScoreReport(evidence);
        const workerIds = evidence.children.map((c) => c.worker_id);
        const snapshot = buildSnapshot(report, evidence.grouping_keys, workerIds);
        const path = appendSnapshot(root, snapshot, cmdOptions.historyPath);
        process.stdout.write(`Snapshot saved to ${path}\n`);
      } catch (err) {
        process.stderr.write(
          `sol history save error: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exit(1);
      }
    });

  history
    .command("report")
    .description("Generate a report from SOL historical snapshots")
    .option("-r, --repo-root <path>", "Repository root", repoRoot)
    .option("--history-path <path>", "Custom history directory (relative to repo root)")
    .option("--group-by <dims>", "Comma-separated grouping dimensions (repo,route,task_type,role,risk,provider,model,worker_id,run_id,time_window)", "run_id")
    .option("--window-days <days>", "Time window size in days for time_window grouping", "7")
    .option("--json", "Output raw JSON (default: human-readable table)")
    .action((cmdOptions: { repoRoot: string; historyPath?: string; groupBy: string; windowDays: string; json?: boolean }) => {
      const root = resolve(cmdOptions.repoRoot ?? repoRoot);
      try {
        assertPolarisDevContext(root);
      } catch (err) {
        process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }

      try {
        const snapshots = loadSnapshots(root, cmdOptions.historyPath);
        const groupBy = cmdOptions.groupBy.split(",").filter(Boolean) as SolReportGroupBy[];
        const windowDays = parseInt(cmdOptions.windowDays, 10) || 7;
        const report = generateReport(snapshots, { groupBy, windowDays });

        if (cmdOptions.json) {
          process.stdout.write(JSON.stringify(report) + "\n");
        } else {
          process.stdout.write(formatReportCli(report));
        }
      } catch (err) {
        process.stderr.write(
          `sol history report error: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exit(1);
      }
    });

  sol.addCommand(history);

  return sol;
}

/** @deprecated Use {@link createSolCommand}. */
export const createAutoresearchCommand = createSolCommand;
