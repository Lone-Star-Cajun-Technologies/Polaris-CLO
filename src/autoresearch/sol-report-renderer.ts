/**
 * SOL SmartDocs Markdown report renderer.
 *
 * Renders human-readable SOL evaluation reports from a run-level
 * evaluation record, the computed scorecard set, and optional QC
 * follow-up recommendations.
 *
 * Reports include:
 *   - Source references back to raw evidence
 *   - Per-subject confidence and availability
 *   - Skipped dimensions with reasons
 *   - Window / grouping metadata
 *   - Recommendation inputs for downstream routing advice
 */

import type { SolEvaluationRecord } from "./sol-evaluation-writer.js";
import type { SolScorecardSet } from "./sol-scorecard-calculator.js";
import type { QcRecommendationsReport } from "./sol-recommendations.js";
import type { SolScorecard } from "../types/sol-scorecard.js";

// ──────────────────────────────────────────────
// Formatting helpers
// ──────────────────────────────────────────────

function fmtScore(v: number | null): string {
  return v !== null ? v.toFixed(4) : "N/A";
}

function fmtBoolean(v: boolean | null): string {
  if (v === null) return "N/A";
  return v ? "Yes" : "No";
}

function fmtList(items: string[] | undefined): string {
  if (!items || items.length === 0) return "_None_";
  return items.map((i) => `- ${i}`).join("\n");
}

function escapeCell(s: string): string {
  // Normalize line breaks so table cells remain valid Markdown.
  return s.replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();
}

// ──────────────────────────────────────────────
// Subscore table
// ──────────────────────────────────────────────

function renderSubscoreTable(scorecard: {
  subscores: { dimension: string; score: number | null; confidence: string; skipped_reason?: string; detail?: string }[];
}): string {
  const rows = scorecard.subscores.map((s) => {
    const value = s.score !== null ? fmtScore(s.score) : "_skipped_";
    const reason = s.skipped_reason ? ` (${s.skipped_reason})` : "";
    const detail = s.detail ? ` ${s.detail}` : "";
    return `| ${s.dimension} | ${value} | ${s.confidence} | ${escapeCell(reason + detail) || "—"} |`;
  });

  return [
    "| Dimension | Score | Confidence | Notes |",
    "|---|---|---|---|",
    ...rows,
  ].join("\n");
}

// ──────────────────────────────────────────────
// Source references
// ──────────────────────────────────────────────

function renderSourceRefs(
  refs: { kind: string; path: string; available: boolean; unavailable_reason?: string }[],
): string {
  const unique = new Map<string, typeof refs[number]>();
  for (const ref of refs) {
    unique.set(`${ref.kind}|${ref.path}`, ref);
  }
  const rows = Array.from(unique.values())
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((r) => {
      const status = r.available ? "available" : `missing${r.unavailable_reason ? `: ${r.unavailable_reason}` : ""}`;
      return `| ${r.kind} | \`${r.path}\` | ${status} |`;
    });

  return [
    "| Kind | Path | Status |",
    "|---|---|---|",
    ...rows,
  ].join("\n");
}

// ──────────────────────────────────────────────
// Recommendation inputs
// ──────────────────────────────────────────────

function renderRecommendationInputs(scorecard: SolScorecard): string {
  const i = scorecard.recommendation_inputs;
  const flags: string[] = [];
  if (i.below_threshold) flags.push("below threshold");
  if (i.over_token_budget) flags.push("over token budget");
  if (i.intervention_detected) flags.push("intervention detected");
  if (i.router_issue_detected) flags.push("router issue detected");
  if (i.qc_issue_detected) flags.push("QC issue detected");

  const cells = [
    scorecard.subject,
    scorecard.subject_key,
    flags.length > 0 ? flags.join(", ") : "—",
    i.low_scoring_dimensions.join(", ") || "—",
    i.skipped_dimensions.join(", ") || "—",
  ];
  return `| ${cells.map(escapeCell).join(" | ")} |`;
}

function renderRecommendationInputsHeader(): string {
  return [
    "| Subject | Key | Flags | Low dimensions | Skipped dimensions |",
    "|---|---|---|---|---|",
  ].join("\n");
}

// ──────────────────────────────────────────────
// Scorecard detail section
// ──────────────────────────────────────────────

function renderScorecardDetail(scorecard: SolScorecard): string {
  const lines: string[] = [];
  lines.push(`### ${scorecard.subject}: ${scorecard.subject_key}`);
  lines.push("");
  lines.push(`- **Availability:** ${scorecard.availability}${
    scorecard.availability_reason ? ` — ${scorecard.availability_reason}` : ""
  }`);
  lines.push(`- **Aggregate score:** ${fmtScore(scorecard.aggregate_score)} (${scorecard.aggregate_confidence})`);
  lines.push(`- **Aggregate formula:** \`${scorecard.aggregate_formula_version}\``);
  lines.push(`- **Window:** run_id=${scorecard.window.run_id ?? "n/a"}, cluster_id=${scorecard.window.cluster_id ?? "n/a"}, sample_count=${scorecard.window.sample_count ?? "n/a"}`);

  const grouping = Object.entries(scorecard.grouping_keys)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
  lines.push(`- **Grouping keys:** ${grouping || "—"}`);
  lines.push("");
  lines.push(renderSubscoreTable(scorecard));
  lines.push("");
  lines.push("**Source references**");
  lines.push("");
  lines.push(renderSourceRefs(scorecard.source_refs));
  lines.push("");
  return lines.join("\n");
}

// ──────────────────────────────────────────────
// Public renderer
// ──────────────────────────────────────────────

export interface SolRenderedReport {
  markdown: string;
  summary: {
    run_id: string;
    aggregate_score: number | null;
    scorecard_count: number;
    skipped_dimensions: number;
  };
}

/**
 * Render a complete SOL evaluation report as Markdown.
 */
export function renderSolMarkdown(
  record: SolEvaluationRecord,
  scorecardSet: SolScorecardSet,
  qcRecommendations?: QcRecommendationsReport,
): SolRenderedReport {
  const allScorecards = [
    scorecardSet.foreman,
    ...scorecardSet.workers,
    ...scorecardSet.providers,
    ...scorecardSet.models,
    ...scorecardSet.routing,
  ];

  const skipped = allScorecards.flatMap((s) =>
    s.subscores
      .filter((sub) => sub.score === null && sub.skipped_reason)
      .map((sub) => ({ subject: s.subject, key: s.subject_key, dimension: sub.dimension, reason: sub.skipped_reason! })),
  );

  const lines: string[] = [];
  lines.push(`# SOL Evaluation Report: ${record.run_id}`);
  lines.push("");
  lines.push(`**Generated:** ${record.generated_at}`);
  lines.push(`**Scored at:** ${record.scored_at}`);
  lines.push(`**Cluster:** ${record.cluster_id ?? "n/a"}`);
  lines.push("");

  // Run-level summary
  lines.push("## Run summary");
  lines.push("");
  lines.push(`| Metric | Value |`);
  lines.push(`|---|---|`);
  lines.push(`| Run composite score | ${fmtScore(record.report.run_composite_score)} |`);
  lines.push(`| Foreman composite | ${fmtScore(record.report.foreman.composite_score)} (${record.report.foreman.composite_confidence}) |`);
  lines.push(`| Worker count | ${Object.keys(record.report.workers).length} |`);
  lines.push(`| Scorecards produced | ${allScorecards.length} |`);
  lines.push("");

  // Scorecard index
  lines.push("## Scorecard index");
  lines.push("");
  lines.push("| Subject | Key | Aggregate | Confidence | Availability |");
  lines.push("|---|---|---|---|---|");
  for (const s of allScorecards) {
    lines.push(
      `| ${s.subject} | ${escapeCell(s.subject_key)} | ${fmtScore(s.aggregate_score)} | ${s.aggregate_confidence} | ${s.availability} |`,
    );
  }
  lines.push("");

  // Foreman
  lines.push("## Foreman");
  lines.push("");
  lines.push(renderScorecardDetail(scorecardSet.foreman));

  // Workers
  if (scorecardSet.workers.length > 0) {
    lines.push("## Workers");
    lines.push("");
    for (const s of scorecardSet.workers) {
      lines.push(renderScorecardDetail(s));
    }
  }

  // Providers
  if (scorecardSet.providers.length > 0) {
    lines.push("## Providers");
    lines.push("");
    for (const s of scorecardSet.providers) {
      lines.push(renderScorecardDetail(s));
    }
  }

  // Models
  if (scorecardSet.models.length > 0) {
    lines.push("## Models");
    lines.push("");
    for (const s of scorecardSet.models) {
      lines.push(renderScorecardDetail(s));
    }
  }

  // Routing
  if (scorecardSet.routing.length > 0) {
    lines.push("## Routing decisions");
    lines.push("");
    for (const s of scorecardSet.routing) {
      lines.push(renderScorecardDetail(s));
    }
  }

  // Token efficiency
  lines.push("## Token efficiency");
  lines.push("");
  const qptScorecards = allScorecards.filter((s) =>
    s.subscores.some((sub) => sub.dimension === "quality_per_token"),
  );
  if (qptScorecards.length === 0) {
    lines.push("No quality-per-token subscores were computed (token evidence may be missing).");
  } else {
    lines.push("| Subject | Key | Quality / token | Confidence |");
    lines.push("|---|---|---|---|");
    for (const s of qptScorecards) {
      const qpt = s.subscores.find((sub) => sub.dimension === "quality_per_token");
      lines.push(
        `| ${s.subject} | ${escapeCell(s.subject_key)} | ${fmtScore(qpt?.score ?? null)} | ${qpt?.confidence ?? "none"} |`,
      );
    }
  }
  lines.push("");

  // QC outcome
  lines.push("## QC outcome");
  lines.push("");
  const foremanQc = scorecardSet.foreman.subscores.find((s) => s.dimension === "qc_repair_loop");
  if (!foremanQc) {
    lines.push("No QC repair-loop subscore available.");
  } else if (foremanQc.score === null) {
    lines.push(`QC repair-loop dimension skipped: ${foremanQc.skipped_reason ?? "no reason given"}.`);
  } else {
    lines.push(`QC repair-loop score: **${fmtScore(foremanQc.score)}** (${foremanQc.confidence})${
      foremanQc.detail ? ` — ${escapeCell(foremanQc.detail)}` : ""
    }`);
  }
  lines.push("");
  if (qcRecommendations && qcRecommendations.recommendations.length > 0) {
    lines.push("### QC follow-up recommendations");
    lines.push("");
    for (const r of qcRecommendations.recommendations) {
      lines.push(`- **[${r.action_type}] ${r.id}** — ${escapeCell(r.proposed_action)} (${(r.confidence * 100).toFixed(1)}% confidence)`);
      lines.push(`  - Rationale: ${escapeCell(r.rationale)}`);
    }
    lines.push("");
  }

  // Recommendation inputs
  lines.push("## Recommendation inputs");
  lines.push("");
  lines.push(renderRecommendationInputsHeader());
  for (const s of allScorecards) {
    lines.push(renderRecommendationInputs(s));
  }
  lines.push("");

  // Skipped evidence
  lines.push("## Skipped evidence");
  lines.push("");
  if (skipped.length === 0) {
    lines.push("All dimensions were scored; no evidence was skipped.");
  } else {
    lines.push("| Subject | Key | Dimension | Reason |");
    lines.push("|---|---|---|---|");
    for (const row of skipped) {
      lines.push(
        `| ${row.subject} | ${escapeCell(row.key)} | ${row.dimension} | ${escapeCell(row.reason)} |`,
      );
    }
  }
  lines.push("");

  // Source references (aggregated)
  lines.push("## Source references");
  lines.push("");
  lines.push(renderSourceRefs(allScorecards.flatMap((s) => s.source_refs)));
  lines.push("");

  const markdown = lines.join("\n");
  return {
    markdown,
    summary: {
      run_id: record.run_id,
      aggregate_score: record.report.run_composite_score,
      scorecard_count: allScorecards.length,
      skipped_dimensions: skipped.length,
    },
  };
}
