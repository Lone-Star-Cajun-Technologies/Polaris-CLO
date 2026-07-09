/**
 * QC escalation criteria → run-health evidence refs.
 *
 * QC providers are artifact producers only; they never write to the
 * run-health report directly. This module is called by Foreman/orchestration
 * code after QC results are available, and it determines which results meet
 * escalation criteria before appending evidence-referenced symptoms to the
 * run-health report.
 *
 * Escalation criteria:
 *   - blocking findings (policyDecision.blocksDelivery)
 *   - repeated findings after repair (findings present in a post-repair rerun)
 *   - unusable output (failureReason: "unusable-output")
 *   - parse failure (parserResult: "failed")
 *   - all providers failed (allProvidersFailed flag)
 *   - noisy provider output (large findings count with no blocking finding)
 *   - max repair rounds exhausted
 *   - repair-loop dispatch failures (medic-referral outcome)
 */

import { randomUUID } from "node:crypto";
import type { QcResult } from "../qc/types.js";
import {
  createRunHealthReport,
  appendSymptom,
  readRunHealthReport,
} from "./index.js";
import type { RunHealthSymptom, SourceActor } from "./schema.js";
import type { QcRepairLoopResult } from "../qc/repair-loop.js";

// ── Escalation codes ──────────────────────────────────────────────────────────

export type QcEscalationCode =
  | "qc-blocking-findings"
  | "qc-repeated-findings"
  | "qc-unusable-output"
  | "qc-parse-failure"
  | "qc-all-providers-failed"
  | "qc-noisy-output"
  | "qc-max-repair-rounds"
  | "qc-repair-dispatch-failure";

/**
 * Threshold for "noisy output": more than this many findings without a
 * blocking finding is classified as noisy.
 */
const NOISY_FINDINGS_THRESHOLD = 20;

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeQcSourceActor(): SourceActor {
  return { role: "foreman" };
}

function makeQcSymptom(
  code: QcEscalationCode,
  message: string,
  evidenceRefs: string[],
): RunHealthSymptom {
  return {
    id: `qc:${code}:${randomUUID()}`,
    severity: qcEscalationSeverity(code),
    code,
    message,
    source_actor: makeQcSourceActor(),
    evidence_refs: evidenceRefs,
    occurred_at: new Date().toISOString(),
  };
}

function qcEscalationSeverity(code: QcEscalationCode): RunHealthSymptom["severity"] {
  switch (code) {
    case "qc-blocking-findings":
    case "qc-all-providers-failed":
    case "qc-repair-dispatch-failure":
      return "high";
    case "qc-repeated-findings":
    case "qc-parse-failure":
    case "qc-unusable-output":
    case "qc-max-repair-rounds":
      return "medium";
    case "qc-noisy-output":
      return "low";
    default:
      return "medium";
  }
}

function upsertQcSymptom(
  runId: string,
  clusterId: string,
  symptom: RunHealthSymptom,
  repoRoot: string | undefined,
): void {
  try {
    const existing = readRunHealthReport(runId, repoRoot);
    if (!existing) {
      createRunHealthReport({
        runId,
        clusterId,
        firstSymptom: symptom,
        sourceActor: makeQcSourceActor(),
        repoRoot,
      });
    } else {
      appendSymptom(runId, symptom, repoRoot);
    }
  } catch {
    // QC escalation must never block the run.
    // ponytail: surface to telemetry in a future pass
  }
}

// ── Public API ─────────────────────────────────────────────────────────────────

export interface AppendQcEscalationSymptomsParams {
  runId: string;
  clusterId: string;
  qcResults: QcResult[];
  /**
   * Whether these results are from a post-repair rerun.
   * When true, any surviving findings are classified as "repeated findings
   * after repair" in addition to their primary escalation reason.
   */
  afterRepair?: boolean;
  repoRoot?: string;
}

/**
 * Evaluate QC results against escalation criteria and append any matching
 * symptoms to the run-health report.
 *
 * No-ops when no escalation criteria are met.
 * Never throws.
 */
export function appendQcEscalationSymptoms(
  params: AppendQcEscalationSymptomsParams,
): void {
  const { runId, clusterId, qcResults, afterRepair = false, repoRoot } = params;

  // Collect artifact paths as evidence refs for each result.
  const allEvidenceRefs = qcResults.flatMap((r) => r.rawArtifactPaths ?? []);

  // ── All providers failed ───────────────────────────────────────────────────
  const allFailed =
    qcResults.length > 0 && qcResults.every((r) => r.allProvidersFailed || r.status === "failed");
  if (allFailed) {
    upsertQcSymptom(
      runId,
      clusterId,
      makeQcSymptom(
        "qc-all-providers-failed",
        `All QC providers failed (${qcResults.length} provider(s)); no review was performed.`,
        allEvidenceRefs,
      ),
      repoRoot,
    );
    return; // If all providers failed, other criteria cannot be evaluated reliably.
  }

  for (const result of qcResults) {
    const evidenceRefs = result.rawArtifactPaths ?? [];

    // ── Parse failure ──────────────────────────────────────────────────────
    if (result.providerAttempt?.parserResult === "failed") {
      upsertQcSymptom(
        runId,
        clusterId,
        makeQcSymptom(
          "qc-parse-failure",
          `QC provider "${result.provider}" output could not be parsed (qcRunId: ${result.qcRunId}).`,
          evidenceRefs,
        ),
        repoRoot,
      );
      continue; // No findings to evaluate from a failed parse.
    }

    // ── Unusable output ────────────────────────────────────────────────────
    if (
      result.providerAttempt?.failureReason === "unusable-output" ||
      result.providerAttempt?.failureReason === "empty-output"
    ) {
      upsertQcSymptom(
        runId,
        clusterId,
        makeQcSymptom(
          "qc-unusable-output",
          `QC provider "${result.provider}" produced unusable output (reason: ${result.providerAttempt.failureReason}).`,
          evidenceRefs,
        ),
        repoRoot,
      );
      continue;
    }

    // ── Blocking findings ──────────────────────────────────────────────────
    if (result.policyDecision?.blocksDelivery) {
      const blockingCount = result.findings.filter(
        (f) => f.status === "open" || f.status === "follow-up",
      ).length;
      upsertQcSymptom(
        runId,
        clusterId,
        makeQcSymptom(
          "qc-blocking-findings",
          `QC provider "${result.provider}" has ${blockingCount} blocking finding(s) that prevent delivery (qcRunId: ${result.qcRunId}).`,
          evidenceRefs,
        ),
        repoRoot,
      );
    }

    // ── Repeated findings after repair ─────────────────────────────────────
    if (afterRepair && result.findings.some((f) => f.status === "open")) {
      const repeatedCount = result.findings.filter((f) => f.status === "open").length;
      upsertQcSymptom(
        runId,
        clusterId,
        makeQcSymptom(
          "qc-repeated-findings",
          `QC provider "${result.provider}" still shows ${repeatedCount} open finding(s) after repair (qcRunId: ${result.qcRunId}).`,
          evidenceRefs,
        ),
        repoRoot,
      );
    }

    // ── Noisy provider output ──────────────────────────────────────────────
    if (
      result.findings.length > NOISY_FINDINGS_THRESHOLD &&
      !result.policyDecision?.blocksDelivery
    ) {
      upsertQcSymptom(
        runId,
        clusterId,
        makeQcSymptom(
          "qc-noisy-output",
          `QC provider "${result.provider}" produced ${result.findings.length} findings (>${NOISY_FINDINGS_THRESHOLD} threshold) without a blocking policy decision — possible noise.`,
          evidenceRefs,
        ),
        repoRoot,
      );
    }
  }
}

// ── Repair loop outcome escalation ────────────────────────────────────────────

export interface AppendRepairLoopOutcomeSymptomParams {
  runId: string;
  clusterId: string;
  repairResult: QcRepairLoopResult;
  repoRoot?: string;
}

/**
 * Append run-health symptoms for non-passing QC repair loop outcomes.
 *
 * Handles: max-rounds, medic-referral (repair dispatch failure), all-providers-failed.
 * The pass/no-repairable/qc-disabled/operator-review outcomes produce no symptoms.
 * Never throws.
 */
export function appendRepairLoopOutcomeSymptom(
  params: AppendRepairLoopOutcomeSymptomParams,
): void {
  const { runId, clusterId, repairResult, repoRoot } = params;
  const evidenceRefs = repairResult.final_qc_results.flatMap((r) => r.rawArtifactPaths ?? []);

  switch (repairResult.outcome) {
    case "max-rounds":
      upsertQcSymptom(
        runId,
        clusterId,
        makeQcSymptom(
          "qc-max-repair-rounds",
          `QC repair loop exhausted max rounds (${repairResult.rounds_completed}) without passing: ${repairResult.summary}`,
          evidenceRefs,
        ),
        repoRoot,
      );
      break;

    case "medic-referral":
      upsertQcSymptom(
        runId,
        clusterId,
        makeQcSymptom(
          "qc-repair-dispatch-failure",
          `QC repair loop terminated with Medic referral after ${repairResult.rounds_completed} round(s) — repair worker(s) failed: ${repairResult.summary}`,
          evidenceRefs,
        ),
        repoRoot,
      );
      break;

    case "all-providers-failed":
      upsertQcSymptom(
        runId,
        clusterId,
        makeQcSymptom(
          "qc-all-providers-failed",
          `All QC providers failed during repair loop (rounds: ${repairResult.rounds_completed}): ${repairResult.summary}`,
          evidenceRefs,
        ),
        repoRoot,
      );
      break;

    // pass, no-repairable, qc-disabled, operator-review — no symptom needed
    default:
      break;
  }
}
