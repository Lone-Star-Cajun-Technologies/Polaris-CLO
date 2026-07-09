/**
 * SOL → run-health bridge.
 *
 * Evaluates SOL score reports against operator-configured thresholds and,
 * when policy enables it, appends run-health symptoms so that Medic can be
 * engaged even when no worker explicitly wrote symptoms.
 *
 * Design rules:
 *   - SOL is ADVISORY by default. No symptoms are created unless the operator
 *     sets `sol.thresholds.enabled = true` AND at least one policy flag
 *     (`createRunHealthReport` or `requireMedic`) is true.
 *   - Symptoms reference the SOL evidence file as their source; they do NOT
 *     mutate raw metric artifacts.
 *   - Each threshold crossing produces exactly one symptom per evaluation.
 *     Re-evaluating the same run does not duplicate symptoms because the
 *     symptom id encodes the threshold name.
 *   - Never throws — threshold evaluation must not block the run.
 */

import { randomUUID } from "node:crypto";
import type {
  SolForemanScoreReport,
  SolWorkerScoreReport,
  SolScoreReport,
} from "../types/sol-score.js";
import type { SolThresholdsConfig } from "../config/schema.js";
import {
  createRunHealthReport,
  appendSymptom,
  readRunHealthReport,
  markMedicDecision,
} from "../run-health/index.js";
import type { RunHealthSymptom, SourceActor } from "../run-health/schema.js";

// ── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_LOW_COMPOSITE_SCORE = 0.4;
const DEFAULT_QC_REPAIR_LOOP_FAILURE_STATUSES = [
  "max-rounds",
  "medic-referral",
  "all-providers-failed",
];
const DEFAULT_REPEATED_PROVIDER_FAILURES = 3;
const DEFAULT_FOREMAN_INTERVENTION_COUNT = 2;
const DEFAULT_STALE_WRONG_RUN_TELEMETRY = true;
const DEFAULT_VALIDATION_FAILURES = 2;

// ── Types ─────────────────────────────────────────────────────────────────────

export type SolThresholdCode =
  | "sol-low-composite-score"
  | "sol-qc-repair-loop-failure"
  | "sol-repeated-provider-failures"
  | "sol-high-foreman-intervention"
  | "sol-stale-wrong-run-telemetry"
  | "sol-validation-failures";

export interface SolThresholdCrossing {
  code: SolThresholdCode;
  message: string;
  evidenceRefs: string[];
}

export interface EvaluateSolThresholdsParams {
  runId: string;
  clusterId: string;
  scoreReport: SolScoreReport;
  /**
   * Path(s) to the SOL score snapshot or evaluation artifact.
   * Referenced as evidence — never mutated.
   */
  evidencePaths?: string[];
  thresholdsConfig: SolThresholdsConfig;
  repoRoot?: string;
}

export interface EvaluateSolThresholdsResult {
  /** Threshold crossings that were detected. */
  crossings: SolThresholdCrossing[];
  /** Number of symptoms appended (0 when advisory-only). */
  symptomsAppended: number;
  /** Whether the Medic-required flag was set on the run-health report. */
  medicRequired: boolean;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeSolSourceActor(): SourceActor {
  return { role: "sol" };
}

function makeSolSymptom(
  crossing: SolThresholdCrossing,
): RunHealthSymptom {
  return {
    // Deterministic id: code only (no UUID) so repeated evaluations of the
    // same run are idempotent — the same threshold crossing produces the
    // same id, and a caller that deduplicates by id will skip the duplicate.
    // ponytail: when run-health supports upsert-by-id, switch to that.
    id: `sol:${crossing.code}`,
    severity: solThresholdSeverity(crossing.code),
    code: crossing.code,
    message: crossing.message,
    source_actor: makeSolSourceActor(),
    evidence_refs: crossing.evidenceRefs,
    occurred_at: new Date().toISOString(),
  };
}

function solThresholdSeverity(code: SolThresholdCode): RunHealthSymptom["severity"] {
  switch (code) {
    case "sol-qc-repair-loop-failure":
    case "sol-repeated-provider-failures":
      return "high";
    case "sol-low-composite-score":
    case "sol-high-foreman-intervention":
    case "sol-validation-failures":
      return "medium";
    case "sol-stale-wrong-run-telemetry":
      return "high";
    default:
      return "medium";
  }
}

function upsertSolSymptom(
  runId: string,
  clusterId: string,
  symptom: RunHealthSymptom,
  repoRoot: string | undefined,
): void {
  const existing = readRunHealthReport(runId, repoRoot);
  if (!existing) {
    createRunHealthReport({
      runId,
      clusterId,
      firstSymptom: symptom,
      sourceActor: makeSolSourceActor(),
      repoRoot,
    });
  } else {
    // Deduplicate: skip if a symptom with the same id already exists
    if (existing.symptoms.some((s) => s.id === symptom.id)) {
      return;
    }
    appendSymptom(runId, symptom, repoRoot);
  }
}

// ── Threshold evaluation ──────────────────────────────────────────────────────

/**
 * Detect which thresholds are crossed given the SOL score report.
 * Returns an array of crossing descriptors without any I/O side effects.
 */
export function detectSolThresholdCrossings(
  scoreReport: SolScoreReport,
  thresholdsConfig: SolThresholdsConfig,
  evidencePaths: string[],
): SolThresholdCrossing[] {
  const crossings: SolThresholdCrossing[] = [];

  const lowCompositeThreshold =
    thresholdsConfig.low_composite_score ?? DEFAULT_LOW_COMPOSITE_SCORE;
  const qcFailureStatuses =
    thresholdsConfig.qc_repair_loop_failure_statuses ?? DEFAULT_QC_REPAIR_LOOP_FAILURE_STATUSES;
  const providerFailureThreshold =
    thresholdsConfig.repeated_provider_failures ?? DEFAULT_REPEATED_PROVIDER_FAILURES;
  const interventionThreshold =
    thresholdsConfig.foreman_intervention_count ?? DEFAULT_FOREMAN_INTERVENTION_COUNT;
  const checkStaleWrongRun =
    thresholdsConfig.stale_wrong_run_telemetry ?? DEFAULT_STALE_WRONG_RUN_TELEMETRY;
  const validationFailureThreshold =
    thresholdsConfig.validation_failures ?? DEFAULT_VALIDATION_FAILURES;

  // 1. Low composite score
  if (
    scoreReport.run_composite_score !== null &&
    scoreReport.run_composite_score < lowCompositeThreshold
  ) {
    crossings.push({
      code: "sol-low-composite-score",
      message:
        `SOL run composite score ${scoreReport.run_composite_score.toFixed(4)} is below ` +
        `configured threshold ${lowCompositeThreshold} — run health may be degraded.`,
      evidenceRefs: evidencePaths,
    });
  }

  // 2. QC repair-loop failure state
  const foremanReport = scoreReport.foreman;
  const qcRepairLoopDetail = foremanReport.qc_repair_loop?.detail ?? "";
  for (const status of qcFailureStatuses) {
    if (qcRepairLoopDetail.includes(`status=${status}`)) {
      crossings.push({
        code: "sol-qc-repair-loop-failure",
        message:
          `SOL evidence shows QC repair loop reached failure status "${status}" — ` +
          `Medic consultation is recommended.`,
        evidenceRefs: evidencePaths,
      });
      break; // One symptom per run for QC repair-loop failures
    }
  }

  // Also detect via qc_repair_loop score == 0
  if (
    foremanReport.qc_repair_loop?.score !== null &&
    foremanReport.qc_repair_loop?.score === 0 &&
    crossings.every((c) => c.code !== "sol-qc-repair-loop-failure")
  ) {
    crossings.push({
      code: "sol-qc-repair-loop-failure",
      message:
        `SOL evidence shows QC repair loop score 0.0 (worst outcome) — ` +
        `Medic consultation is recommended.`,
      evidenceRefs: evidencePaths,
    });
  }

  // 3. Repeated provider failures — inferred from worker composite scores ≤ 0
  //    and workers_failed count (available through foreman scores proxy).
  const failedWorkers = Object.values(scoreReport.workers).filter(
    (w) => w.composite_score !== null && w.composite_score <= 0,
  );
  if (failedWorkers.length >= providerFailureThreshold) {
    crossings.push({
      code: "sol-repeated-provider-failures",
      message:
        `SOL evidence shows ${failedWorkers.length} worker(s) with zero composite score ` +
        `(threshold: ${providerFailureThreshold}) — possible repeated provider failures.`,
      evidenceRefs: evidencePaths,
    });
  }

  // 4. High Foreman intervention count
  // intervention.score: 0.0 = user_intervened, 0.5 = foreman_intervened
  const interventionScore = foremanReport.intervention?.score;
  if (interventionScore !== null && interventionScore !== undefined) {
    // pre_analysis dimension uses escalation_events as a proxy
    // intervention score < 0.5 means foreman_intervened; 0.0 means user_intervened
    // We use the foreman.pre_analysis detail to extract escalation_events
    const preAnalysisDetail = foremanReport.pre_analysis?.detail ?? "";
    const escalationMatch = /escalation_events=(\d+)/.exec(preAnalysisDetail);
    const escalationEvents = escalationMatch ? parseInt(escalationMatch[1], 10) : 0;
    if (escalationEvents > interventionThreshold) {
      crossings.push({
        code: "sol-high-foreman-intervention",
        message:
          `SOL evidence shows ${escalationEvents} escalation event(s) ` +
          `(threshold: ${interventionThreshold}) — possible Foreman intervention loop.`,
        evidenceRefs: evidencePaths,
      });
    }
  }

  // 5. Stale / wrong-run telemetry
  // Detected via foreman.dispatch and foreman.duration dimension details
  if (checkStaleWrongRun) {
    const dispatchDetail = foremanReport.dispatch?.detail ?? "";
    const durationDetail = foremanReport.duration?.detail ?? "";
    const hasRedispatch = /redispatched=\d+\//.exec(dispatchDetail);
    const redispatchCount = hasRedispatch
      ? parseInt(/redispatched=(\d+)/.exec(dispatchDetail)?.[1] ?? "0", 10)
      : 0;
    // dispatch_epoch >> continue_epoch suggests wrong-run telemetry
    const dispatchEpochMatch = /dispatch_epoch=(\d+)/.exec(durationDetail);
    const continueEpochMatch = /continue_epoch=(\d+)/.exec(durationDetail);
    const dispatchEpoch = dispatchEpochMatch ? parseInt(dispatchEpochMatch[1], 10) : 0;
    const continueEpoch = continueEpochMatch ? parseInt(continueEpochMatch[1], 10) : 0;
    const epochOverhead = dispatchEpoch > 0 ? dispatchEpoch - (continueEpoch + 1) : 0;

    if (redispatchCount >= providerFailureThreshold || epochOverhead >= 3) {
      crossings.push({
        code: "sol-stale-wrong-run-telemetry",
        message:
          `SOL evidence suggests stale or wrong-run telemetry: ` +
          `redispatched=${redispatchCount}, epoch_overhead=${epochOverhead}. ` +
          `This pattern is consistent with the POL-509 wrong-run failure mode.`,
        evidenceRefs: evidencePaths,
      });
    }
  }

  // 6. Validation failures
  const validationFailedWorkers = Object.values(scoreReport.workers).filter(
    (w) => w.validation?.score !== null && w.validation?.score === 0,
  );
  if (validationFailedWorkers.length >= validationFailureThreshold) {
    crossings.push({
      code: "sol-validation-failures",
      message:
        `SOL evidence shows ${validationFailedWorkers.length} worker(s) with validation failures ` +
        `(threshold: ${validationFailureThreshold}).`,
      evidenceRefs: evidencePaths,
    });
  }

  return crossings;
}

/**
 * Evaluate SOL score thresholds and, when policy enables it, append
 * run-health symptoms for each crossing.
 *
 * Advisory only by default. To activate run-health writes:
 *   `sol.thresholds.enabled = true` AND one of:
 *   `sol.thresholds.policy.createRunHealthReport = true`
 *   `sol.thresholds.policy.requireMedic = true`
 *
 * Never throws — threshold evaluation must not block the run.
 */
export function evaluateSolThresholds(
  params: EvaluateSolThresholdsParams,
): EvaluateSolThresholdsResult {
  const { runId, clusterId, scoreReport, evidencePaths = [], thresholdsConfig, repoRoot } = params;

  const crossings = detectSolThresholdCrossings(scoreReport, thresholdsConfig, evidencePaths);

  const policyEnabled = thresholdsConfig.enabled === true;
  const createReport = thresholdsConfig.policy?.createRunHealthReport === true;
  const requireMedic = thresholdsConfig.policy?.requireMedic === true;
  const shouldWrite = policyEnabled && (createReport || requireMedic);

  if (!shouldWrite || crossings.length === 0) {
    return { crossings, symptomsAppended: 0, medicRequired: false };
  }

  let symptomsAppended = 0;
  let medicDecisionWritten = false;
  try {
    for (const crossing of crossings) {
      upsertSolSymptom(runId, clusterId, makeSolSymptom(crossing), repoRoot);
      symptomsAppended++;
    }

    // If requireMedic is true, set medic_consult to pending so finalize gate fires.
    if (requireMedic && crossings.length > 0) {
      markMedicDecision(runId, { status: "pending" }, repoRoot);
      medicDecisionWritten = true;
    }
  } catch {
    // Threshold evaluation must never block the run.
    // ponytail: surface write errors to telemetry in a future pass
  }

  return {
    crossings,
    symptomsAppended,
    medicRequired: medicDecisionWritten,
  };
}
