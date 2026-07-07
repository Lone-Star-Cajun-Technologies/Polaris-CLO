import type { LoopState } from "../loop/checkpoint.js";
import type { QcScoreSummary } from "../autoresearch/score.js";

export interface RunReportData {
  state: LoopState;
  branch: string;
  validationPassed: boolean;
  prUrl?: string;
  artifacts?: string[];
  notes?: string[];
  /** Optional QC summary to include in the run report. */
  qcSummary?: QcScoreSummary | null;
}

function renderQcSection(qcSummary: QcScoreSummary | null | undefined): string {
  if (!qcSummary) return "";

  const { total_findings, blocking_findings, autofixed_findings, repaired_findings,
          waived_findings, unvalidated_findings, open_by_severity,
          blocks_delivery, qc_run_count, weighted_open_score, qc_penalty,
          provider_breakdown, routing_breakdown } = qcSummary;

  const openTotal = open_by_severity.critical + open_by_severity.high +
                    open_by_severity.medium + open_by_severity.low + open_by_severity.info;

  const deliveryStatus = blocks_delivery
    ? "**BLOCKED** — unresolved critical/high findings must be addressed before delivery"
    : "Not blocking delivery";

  const providers = Object.entries(provider_breakdown)
    .map(([provider, summary]) => `| ${provider} | ${summary.total} | ${summary.blocking} | ${summary.unvalidated} |`)
    .join("\n");

  const routing = `
| original-worker | ${routing_breakdown.original_worker} |
| repair-worker | ${routing_breakdown.repair_worker} |
| follow-up | ${routing_breakdown.follow_up} |
| operator-review | ${routing_breakdown.operator_review} |
| unset | ${routing_breakdown.unset} |`;

  const solImpactValue = qc_penalty > 0
    ? `-${(qc_penalty * 100).toFixed(1)}% (weighted open score ${weighted_open_score.toFixed(2)})`
    : `none (weighted open score ${weighted_open_score.toFixed(2)})`;

  return `
## QC summary

|**QC runs:** ${qc_run_count}
|**Delivery status:** ${deliveryStatus}
|**Total findings:** ${total_findings} (${unvalidated_findings} unvalidated/provider-noise excluded from scoring)
|**SOL score impact:** ${solImpactValue}

|| Status | Count |
|---|---|---|
|| Blocking (critical/high, open) | ${blocking_findings} |
|| Open (all severities) | ${openTotal} |
|| Autofixed | ${autofixed_findings} |
|| Repaired | ${repaired_findings} |
|| Waived | ${waived_findings} |

|**Open by severity:** critical=${open_by_severity.critical} high=${open_by_severity.high} medium=${open_by_severity.medium} low=${open_by_severity.low} info=${open_by_severity.info}

### Providers

| Provider | Total | Blocking | Unvalidated |
|---|---|---|---|
${providers || "| _none_ | — | — | — |"}

### Repair routing

| Decision | Count |
|---|---|
${routing}
`;
}

export function generateRunReport(data: RunReportData): string {
  const { state, branch, validationPassed, prUrl, artifacts, notes, qcSummary } = data;
  const total = state.completed_children.length + state.open_children.length;
  const completedCount = state.completed_children.length;

  const childRows = state.completed_children
    .map((id) => `| ${id} | — | — | Done |`)
    .concat(state.open_children.map((id) => `| ${id} | — | — | Open |`))
    .join("\n");

  const artifactList =
    artifacts && artifacts.length > 0
      ? artifacts.map((a) => `- ${a}`).join("\n")
      : "- current-state.json\n- run-report.md";

  const notesList =
    notes && notes.length > 0
      ? notes.map((n) => `- ${n}`).join("\n")
      : "_None_";

  const blockerNote = state.blocker
    ? `\n**Blocker:** ${state.blocker.reason} (child: ${state.blocker.child_id})\n`
    : "";

  const qcSection = renderQcSection(qcSummary);

  return `# Run Report: ${state.run_id}

|**Status:** ${state.status}
|**Branch:** ${branch}
|**PR:** ${prUrl ?? "TBD — set at delivery step 9"}
|**Children completed:** ${completedCount} of ${total}
|**Validation:** ${validationPassed ? "passed" : "failed"}
${blockerNote}
## Children

|| ID | Title | Commit | Status |
|---|---|---|---|
${childRows || "_No children recorded_"}

## Artifacts produced

${artifactList}

## Validation summary

${validationPassed ? "Map validate passed. Schema validate passed." : "One or more validations failed — see step output above."}
${qcSection}
## Notes

${notesList}
`;
}
