import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { LoopState, QcRepairLoopState } from "../loop/checkpoint.js";
import type { QcResult } from "../qc/types.js";
import { computeQcSummary, loadRunArtifacts, summarizeRouterOutcomes } from "../autoresearch/score.js";
import type { QcScoreSummary, RunArtifacts } from "../autoresearch/score.js";

export interface QcEvidence {
  /** SHA the final trusted QC pass reviewed (from QcResult.headSha). */
  sealedReviewedSha?: string;
  /** SHA of the commit that became the PR head (from qc_repair_loop.sealed_head_sha). */
  prHeadSha?: string;
  /** Number of QC review passes that were run in this finalize sequence. */
  qcReviewPassCount: number;
  /** Count of unresolved advisory-severity (non-blocking) findings. */
  unresolvedAdvisoryCount: number;
  /** Terminal/convergence outcome of the QC repair loop. */
  repairLoopOutcome?: string;
}

export interface RunReportData {
  state: LoopState;
  branch: string;
  validationPassed: boolean;
  prUrl?: string;
  artifacts?: string[];
  notes?: string[];
  /** Optional QC summary to include in the run report. */
  qcSummary?: QcScoreSummary | null;
  /** Optional telemetry events for routing evidence summary. */
  telemetryEvents?: unknown[];
  qcEvidence?: QcEvidence;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

function getHeadSha(repoRoot: string): string | undefined {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" }).trim();
  } catch {
    return undefined;
  }
}

function deriveSealedReviewedSha(
  qcResults: QcResult[],
  loop?: QcRepairLoopState & { sealed_head_sha?: string },
): string | undefined {
  const finalRunIds = new Set<string>();
  if (loop) {
    if (loop.rerun_qc_run_ids && Object.keys(loop.rerun_qc_run_ids).length > 0) {
      const rounds = Object.keys(loop.rerun_qc_run_ids).map(Number);
      const maxRound = Math.max(...rounds);
      for (const id of loop.rerun_qc_run_ids[maxRound] ?? []) {
        finalRunIds.add(id);
      }
    } else {
      for (const id of loop.source_qc_run_ids ?? []) {
        finalRunIds.add(id);
      }
    }
  }

  const withHeadSha = qcResults.filter((r) => r.headSha);
  const candidates = finalRunIds.size > 0
    ? withHeadSha.filter((r) => finalRunIds.has(r.qcRunId))
    : withHeadSha;

  if (candidates.length === 0) return undefined;
  const sorted = [...candidates].sort((a, b) => a.completedAt.localeCompare(b.completedAt));
  return sorted.at(-1)?.headSha;
}

function deriveQcEvidence(
  state: LoopState,
  qcSummary: QcScoreSummary | null,
  qcResults: QcResult[],
  repoRoot?: string,
): QcEvidence {
  const loop = state.qc_repair_loop as (QcRepairLoopState & { sealed_head_sha?: string }) | undefined;
  const openBySeverity = qcSummary?.open_by_severity;
  const unresolvedAdvisoryCount = openBySeverity
    ? openBySeverity.medium + openBySeverity.low + openBySeverity.info
    : 0;
  const repairLoopOutcome = loop?.terminal_outcome ?? qcSummary?.repair_loop?.status ?? undefined;
  const sealedReviewedSha = deriveSealedReviewedSha(qcResults, loop);
  const prHeadSha = loop?.sealed_head_sha ?? (repoRoot ? getHeadSha(repoRoot) : undefined);
  return {
    sealedReviewedSha,
    prHeadSha,
    qcReviewPassCount: qcSummary?.qc_run_count ?? 0,
    unresolvedAdvisoryCount,
    repairLoopOutcome,
  };
}

export function computeRunReportQcEvidence(
  repoRoot: string,
  state: LoopState,
): { qcSummary: QcScoreSummary | null; qcEvidence: QcEvidence; telemetryEvents: unknown[] } {
  const artifacts = loadRunArtifacts(repoRoot, state.run_id);
  const qcSummary = computeQcSummary(artifacts.qcResults, artifacts.clusterState, artifacts.telemetryEvents, state);
  const qcEvidence = deriveQcEvidence(state, qcSummary, artifacts.qcResults, repoRoot);
  return { qcSummary, qcEvidence, telemetryEvents: artifacts.telemetryEvents };
}

export function writeRunReport(
  repoRoot: string,
  state: LoopState,
  branch: string,
  validationPassed: boolean,
  qcSummary?: QcScoreSummary | null,
  qcEvidence?: QcEvidence,
  telemetryEvents?: unknown[],
): string {
  const reportPath = resolve(repoRoot, ".polaris", "runs", "run-report.md");
  mkdirSync(dirname(reportPath), { recursive: true });

  if (qcSummary === undefined || qcEvidence === undefined || telemetryEvents === undefined) {
    const computed = computeRunReportQcEvidence(repoRoot, state);
    qcSummary = qcSummary ?? computed.qcSummary;
    qcEvidence = qcEvidence ?? computed.qcEvidence;
    telemetryEvents = telemetryEvents ?? computed.telemetryEvents;
  }

  const content = generateRunReport({
    state,
    branch,
    validationPassed,
    qcSummary,
    qcEvidence,
    telemetryEvents,
  });

  writeFileSync(reportPath, content, "utf-8");
  console.log(`Run report written: ${reportPath}`);
  return reportPath;
}

function inferCompatibilityMode(selectionReason: string): string | null {
  if (!selectionReason) return null;
  if (selectionReason === "policy-router" || selectionReason.startsWith("router-")) {
    return "router";
  }
  return "compatibility";
}

interface RoutingCell {
  childId: string;
  title: string;
  provider: string;
  selectionReason: string;
  mode: string;
  policyOrder: string[];
  candidateCount: number | null;
  fallbackCount: number;
  status: string;
}

function buildRoutingCell(
  childId: string,
  state: LoopState,
  telemetryEvents: unknown[],
): RoutingCell {
  const meta = asRecord(state.open_children_meta?.[childId]);
  const dispatchRecord = asRecord(meta?.["dispatch_record"]);
  const result = asRecord(state.completed_children_results?.[childId]);
  const completed = state.completed_children.includes(childId);
  const status = completed ? "Done" : "Open";

  const findEvent = (eventName: string): Record<string, unknown> | undefined => {
    const found = telemetryEvents.find((e) => {
      const rec = asRecord(e);
      return rec?.["event"] === eventName && rec?.["child_id"] === childId;
    });
    return asRecord(found);
  };

  const completeEvent = findEvent("child-complete");
  const dispatchedEvent = findEvent("child-dispatched");
  const selectedEvent = findEvent("provider-selected");
  const selectedSlotClaim = asRecord(dispatchedEvent?.["selected_slot_claim"]);

  const routingSummary = asRecord(
    completeEvent?.["routing_summary"] ??
      selectedEvent?.["routing_summary"] ??
      dispatchedEvent?.["routing_summary"] ??
      dispatchRecord?.["routing_summary"],
  );

  const provider = asString(
    completeEvent?.["provider"] ??
      selectedEvent?.["selected_provider"] ??
      dispatchedEvent?.["provider"] ??
      dispatchRecord?.["provider"] ??
      result?.["provider"],
  );

  const selectionReason = asString(
    completeEvent?.["router_selection_reason"] ??
      selectedEvent?.["selection_reason"] ??
      routingSummary?.["selection_reason"] ??
      dispatchRecord?.["provider_selection_reason"] ??
      selectedSlotClaim?.["selection_reason"],
  ) ?? "—";

  const compatibilityMode =
    typeof routingSummary?.["compatibility_mode"] === "boolean"
      ? routingSummary["compatibility_mode"]
      : typeof selectedEvent?.["router_compatibility_mode"] === "boolean"
        ? selectedEvent["router_compatibility_mode"]
        : null;

  const mode =
    compatibilityMode === true
      ? "compatibility"
      : compatibilityMode === false
        ? "router"
        : inferCompatibilityMode(selectionReason) ?? "—";

  const policyOrder = asStringArray(
    routingSummary?.["effective_policy_order"] ??
      selectedEvent?.["providers_tried"] ??
      completeEvent?.["providers_tried"] ??
      dispatchedEvent?.["providers_tried"] ??
      dispatchRecord?.["providers_tried"],
  );

  const candidatesRaw = selectedEvent?.["router_candidates"];
  const candidateCount = Array.isArray(candidatesRaw) ? candidatesRaw.length : null;

  const fallbackRaw = selectedEvent?.["fallback_attempts"];
  const fallbackAttempts = Array.isArray(fallbackRaw) ? fallbackRaw : [];
  const fallbackCount = fallbackAttempts.filter(
    (a) => asRecord(a)?.["outcome"] === "rejected",
  ).length;

  const title = asString(meta?.["title"]) ?? "—";

  return {
    childId,
    title,
    provider: provider ?? "delegated",
    selectionReason,
    mode,
    policyOrder,
    candidateCount,
    fallbackCount,
    status,
  };
}

function renderRoutingSection(state: LoopState, telemetryEvents: unknown[]): string {
  const allChildren = [...state.completed_children, ...state.open_children];
  const cells = allChildren.map((id) => buildRoutingCell(id, state, telemetryEvents));

  const rows = cells
    .map(
      (c) =>
        `| ${c.childId} | ${c.title} | ${c.provider} | ${c.selectionReason} | ${c.mode} | ${c.policyOrder.join(", ") || "—"} | ${c.candidateCount === null ? "—" : c.candidateCount} | ${c.fallbackCount} | ${c.status} |`,
    )
    .join("\n");

  const providerCounts = new Map<string, number>();
  for (const cell of cells) {
    if (cell.provider === "delegated") continue;
    providerCounts.set(cell.provider, (providerCounts.get(cell.provider) ?? 0) + 1);
  }
  const distribution = Array.from(providerCounts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([provider, count]) => `${provider}: ${count}`)
    .join(", ") || "—";

  const artifacts = {
    runId: state.run_id,
    runDir: null,
    clusterDir: null,
    currentState: state,
    ledgerEvents: [],
    resultPackets: [],
    workerResultContracts: [],
    telemetryEvents,
    qcResults: [],
    clusterState: null,
  } as unknown as RunArtifacts;

  const outcomes = summarizeRouterOutcomes(artifacts);

  const anomalyLines: string[] = [];
  anomalyLines.push(`- Total routing decisions: ${outcomes.total_decisions}`);
  anomalyLines.push(`- Exhausted decisions: ${outcomes.exhausted_decisions}`);
  anomalyLines.push(`- Fallback attempts: ${outcomes.fallback_attempts} (${outcomes.successful_fallbacks} successful)`);

  const hasAnomaly =
    outcomes.exhausted_decisions > 0 ||
    outcomes.fallback_attempts > 0 ||
    outcomes.recurring_failures.length > 0 ||
    outcomes.provider_monopoly_signals.length > 0 ||
    outcomes.evidence_gap_signals.length > 0 ||
    outcomes.state_repair_signals.length > 0;

  if (outcomes.recurring_failures.length > 0) {
    anomalyLines.push(`- Recurring router failures:`);
    for (const failure of outcomes.recurring_failures) {
      anomalyLines.push(
        `  - ${failure.reason}: ${failure.occurrences} occurrence(s) — children: ${failure.child_ids.join(", ") || "none"}`,
      );
    }
  }

  if (outcomes.provider_monopoly_signals.length > 0) {
    anomalyLines.push(`- Provider monopoly (repeated same-provider selection):`);
    for (const signal of outcomes.provider_monopoly_signals) {
      anomalyLines.push(
        `  - ${signal.reason}: ${signal.occurrences} occurrence(s) — children: ${signal.child_ids.join(", ") || "none"}`,
      );
    }
  }

  if (outcomes.evidence_gap_signals.length > 0) {
    anomalyLines.push(`- Evidence gaps:`);
    for (const signal of outcomes.evidence_gap_signals) {
      anomalyLines.push(
        `  - ${signal.reason}: ${signal.occurrences} occurrence(s) — children: ${signal.child_ids.join(", ") || "none"}`,
      );
    }
  }

  if (outcomes.state_repair_signals.length > 0) {
    anomalyLines.push(`- State repair / runtime review signals:`);
    for (const signal of outcomes.state_repair_signals) {
      anomalyLines.push(
        `  - ${signal.signal} (${signal.reason}): ${signal.occurrences} occurrence(s) — children: ${signal.child_ids.join(", ") || "none"}`,
      );
    }
  }

  const anomaliesText = hasAnomaly
    ? anomalyLines.join("\n")
    : "No routing anomalies or evidence gaps detected.";

  return `### Provider distribution

| Child | Title | Provider | Selection reason | Mode | Policy order | Candidates | Fallbacks | Status |
|---|---|---|---|---|---|---|---|---|
${rows || "| _No children recorded_ | — | — | — | — | — | — | — | — |"}

**Provider summary:** ${distribution}

### Routing review

${anomaliesText}`;
}

function renderQcSection(
  qcSummary: QcScoreSummary | null | undefined,
  qcEvidence: QcEvidence | undefined,
): string {
  if (!qcSummary && !qcEvidence) return "";

  const unresolvedFromSummary = qcSummary
    ? qcSummary.open_by_severity.medium + qcSummary.open_by_severity.low + qcSummary.open_by_severity.info
    : undefined;

  const {
    sealedReviewedSha,
    prHeadSha,
    qcReviewPassCount,
    unresolvedAdvisoryCount,
    repairLoopOutcome,
  } = qcEvidence ?? {};

  const convergenceTable = `### QC convergence evidence

| Field | Value |
|---|---|
| Sealed reviewed SHA | ${sealedReviewedSha ?? "not recorded"} |
| PR head SHA | ${prHeadSha ?? "not recorded"} |
| QC review passes run | ${qcReviewPassCount ?? qcSummary?.qc_run_count ?? "not available"} |
| Unresolved advisory-severity findings | ${unresolvedAdvisoryCount ?? unresolvedFromSummary ?? "not available"} |
| Repair loop outcome | ${repairLoopOutcome ?? qcSummary?.repair_loop?.status ?? "not recorded"} |`;

  if (!qcSummary) {
    return `
## QC summary

${convergenceTable}`;
  }

  const {
    total_findings,
    blocking_findings,
    autofixed_findings,
    repaired_findings,
    waived_findings,
    unvalidated_findings,
    open_by_severity,
    blocks_delivery,
    qc_run_count,
    weighted_open_score,
    qc_penalty,
    provider_breakdown,
    routing_breakdown,
  } = qcSummary;

  const openTotal =
    open_by_severity.critical +
    open_by_severity.high +
    open_by_severity.medium +
    open_by_severity.low +
    open_by_severity.info;

  const deliveryStatus = blocks_delivery
    ? "**BLOCKED** — unresolved critical/high findings must be addressed before delivery"
    : "Not blocking delivery";

  const providers = Object.entries(provider_breakdown)
    .map(
      ([provider, summary]) =>
        `| ${provider} | ${summary.total} | ${summary.blocking} | ${summary.unvalidated} |`,
    )
    .join("\n");

  const routing = `| original-worker | ${routing_breakdown.original_worker} |
| repair-worker | ${routing_breakdown.repair_worker} |
| follow-up | ${routing_breakdown.follow_up} |
| operator-review | ${routing_breakdown.operator_review} |
| unset | ${routing_breakdown.unset} |`;

  const solImpactValue =
    qc_penalty > 0
      ? `-${(qc_penalty * 100).toFixed(1)}% (weighted open score ${weighted_open_score.toFixed(2)})`
      : `none (weighted open score ${weighted_open_score.toFixed(2)})`;

  return `
## QC summary

${convergenceTable}

### QC metrics

| Metric | Value |
|---|---|
| **QC review passes run** | ${qcReviewPassCount ?? qc_run_count} |
| **Delivery status** | ${deliveryStatus} |
| **Total findings** | ${total_findings} (${unvalidated_findings} unvalidated/provider-noise excluded from scoring) |
| **SOL score impact** | ${solImpactValue} |

| Status | Count |
|---|---|
| Blocking (critical/high, open) | ${blocking_findings} |
| Open (all severities) | ${openTotal} |
| Autofixed | ${autofixed_findings} |
| Repaired | ${repaired_findings} |
| Waived | ${waived_findings} |

| **Open by severity** | critical=${open_by_severity.critical} high=${open_by_severity.high} medium=${open_by_severity.medium} low=${open_by_severity.low} info=${open_by_severity.info} |

### Providers

| Provider | Total | Blocking | Unvalidated |
|---|---|---|---|
${providers || "| _none_ | — | — | — |"}

### Repair routing

| Decision | Count |
|---|---|
${routing}`;
}

export function generateRunReport(data: RunReportData): string {
  const { state, branch, validationPassed, prUrl, artifacts, notes, qcSummary, telemetryEvents, qcEvidence } = data;
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

  const qcSection = renderQcSection(qcSummary, qcEvidence);
  const routingSection = renderRoutingSection(state, telemetryEvents ?? []);

  return `# Run Report: ${state.run_id}

| Field | Value |
|---|---|
| **Status** | ${state.status} |
| **Branch** | ${branch} |
| **PR** | ${prUrl ?? "TBD — set at delivery step 9"} |
| **Children completed** | ${completedCount} of ${total} |
| **Validation** | ${validationPassed ? "passed" : "failed"} |
${blockerNote}## Children

| ID | Title | Commit | Status |
|---|---|---|---|
${childRows || "_No children recorded_"}

## Provider routing

${routingSection}

## Artifacts produced

${artifactList}

## Validation summary

${validationPassed ? "Map validate passed. Schema validate passed." : "One or more validations failed — see step output above."}
${qcSection}
## Notes

${notesList}
`;
}
