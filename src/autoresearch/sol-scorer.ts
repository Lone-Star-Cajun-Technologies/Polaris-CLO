/**
 * SOL scoring engine.
 *
 * Computes diagnostic sub-scores for Foremen and Workers from aggregated
 * SolEvidence. Each dimension independently scores one behavioral signal
 * with an attached confidence and optional skipped_reason.
 *
 * Design rules:
 *   - Never throws on missing evidence — produces skipped dimensions.
 *   - Scores are 0.0–1.0 where 1.0 = optimal behavior.
 *   - Composite score = mean of non-null dimension scores.
 *   - Confidence tiers: high (≥2 signals), medium (1 signal), low (proxy only), none (skipped).
 *   - Binary gate diagnosis is preserved; these scores are additive.
 *   - No routing policy changes are triggered from scores (Non-goal, POL-481).
 */

import type { SolEvidence, SolChildEvidence } from "../types/sol-evidence.js";
import type {
  SolDimensionScore,
  SolForemanScoreReport,
  SolWorkerScoreReport,
  SolScoreReport,
  SolScoreConfidence,
} from "../types/sol-score.js";

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

function dim(
  dimension: string,
  score: number | null,
  confidence: SolScoreConfidence,
  opts: { skipped_reason?: string; detail?: string } = {},
): SolDimensionScore {
  return { dimension, score, confidence, ...opts };
}

function skipped(dimension: string, reason: string): SolDimensionScore {
  return dim(dimension, null, "none", { skipped_reason: reason });
}

/** Clamp a value to [0, 1]. */
function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/**
 * Compute composite score and confidence from a list of dimension scores.
 * Skipped dimensions (score === null) are not counted.
 */
function composite(dims: SolDimensionScore[]): { score: number | null; confidence: SolScoreConfidence } {
  const scored = dims.filter((d) => d.score !== null);
  if (scored.length === 0) return { score: null, confidence: "none" };

  const mean = scored.reduce((s, d) => s + d.score!, 0) / scored.length;
  // Composite confidence = worst of all scored dimensions
  const rank: Record<SolScoreConfidence, number> = { high: 3, medium: 2, low: 1, none: 0 };
  const worstConf = scored.reduce<SolScoreConfidence>((worst, d) => {
    return rank[d.confidence] < rank[worst] ? d.confidence : worst;
  }, "high");

  return { score: Number(mean.toFixed(4)), confidence: worstConf };
}

// ──────────────────────────────────────────────
// Foreman dimension scorers
// ──────────────────────────────────────────────

/**
 * token: Measures bootstrap context efficiency.
 * Score = 1.0 when under budget, decreases linearly above 150k tokens.
 * 150k = warning zone; 300k = 0.0.
 */
function scoreForemanToken(ev: SolEvidence): SolDimensionScore {
  const tokens = ev.foreman.max_bootstrap_tokens;
  if (tokens === null) return skipped("token", "no bootstrap-context-size events in telemetry");

  const BUDGET = 150_000;
  const MAX_PENALIZED = 300_000;
  let score: number;
  if (tokens <= BUDGET) {
    score = 1.0;
  } else {
    // Linear decay from 1.0 at BUDGET to 0.0 at MAX_PENALIZED
    score = clamp01(1.0 - (tokens - BUDGET) / (MAX_PENALIZED - BUDGET));
  }

  return dim(
    "token",
    Number(score.toFixed(4)),
    "high",
    { detail: `max_bootstrap_tokens=${tokens}` },
  );
}

/**
 * duration: Proxy via dispatch epoch overhead.
 * Score = 1.0 at epoch 1, decays with each additional epoch beyond the
 * continue_epoch (re-dispatch overhead).
 * Skipped when no dispatch_boundary evidence.
 */
function scoreForemanDuration(ev: SolEvidence): SolDimensionScore {
  const { dispatch_epoch, continue_epoch } = ev.run;
  if (dispatch_epoch === null) return skipped("duration", "dispatch_epoch unavailable in run state");

  const expected = continue_epoch !== null ? continue_epoch + 1 : 1;
  const overhead = Math.max(0, dispatch_epoch - expected);
  // Each extra epoch subtracts 0.25 from score
  const score = clamp01(1.0 - overhead * 0.25);

  return dim(
    "duration",
    Number(score.toFixed(4)),
    overhead === 0 ? "medium" : "high",
    { detail: `dispatch_epoch=${dispatch_epoch}, continue_epoch=${continue_epoch}` },
  );
}

/**
 * intervention: User and foreman corrective commits.
 * Score = 1.0 when no interventions, 0.5 for foreman-only, 0.0 for user.
 */
function scoreForemanIntervention(ev: SolEvidence): SolDimensionScore {
  const { total_children } = ev.run;
  // Need at least one child to evaluate
  if (total_children === 0 && ev.children.length === 0) {
    return skipped("intervention", "no children observed for intervention assessment");
  }

  const userInt = ev.intervention.user_intervened;
  const foremanInt = ev.intervention.foreman_intervened;

  if (userInt) {
    return dim("intervention", 0.0, "high", { detail: "user_intervened=true" });
  }
  if (foremanInt) {
    return dim("intervention", 0.5, "high", { detail: "foreman_intervened=true" });
  }

  // Both false → clean run
  return dim("intervention", 1.0, "high", { detail: "no user or foreman interventions" });
}

/**
 * pre_analysis: Escalation events as a proxy for pre-analysis gaps.
 * 0 escalations = 1.0; each escalation reduces score.
 */
function scoreForemanPreAnalysis(ev: SolEvidence): SolDimensionScore {
  const escalations = ev.foreman.escalation_events;
  // Without telemetry at all, we can't distinguish "no escalations" from "no telemetry"
  const hasTelemetry = ev.tokens.total_worker_heartbeats > 0 || ev.run.dispatch_epoch !== null;
  if (!hasTelemetry) return skipped("pre_analysis", "no telemetry events to assess escalations");

  const score = clamp01(1.0 - escalations * 0.25);
  const confidence: SolScoreConfidence = escalations > 0 ? "high" : "medium";
  return dim("pre_analysis", Number(score.toFixed(4)), confidence, {
    detail: `escalation_events=${escalations}`,
  });
}

/**
 * dependency: Whether dependent children were dispatched at the correct epoch.
 * Uses re-dispatch count as a proxy for dependency ordering issues.
 * 0 re-dispatches = 1.0; each re-dispatch reduces score.
 */
function scoreForemanDependency(ev: SolEvidence): SolDimensionScore {
  const { redispatch_count } = ev.foreman;
  const hasChildren = ev.run.total_children > 0 || ev.children.length > 0;
  if (!hasChildren) return skipped("dependency", "no children observed for dependency assessment");

  const score = clamp01(1.0 - redispatch_count * 0.33);
  const confidence: SolScoreConfidence = ev.run.dispatch_epoch !== null ? "medium" : "low";
  return dim("dependency", Number(score.toFixed(4)), confidence, {
    detail: `redispatch_count=${redispatch_count}`,
  });
}

/**
 * dispatch: Re-dispatch rate.
 * Score = 1.0 when no child was dispatched more than once.
 * Penalized by proportion of re-dispatched children.
 */
function scoreForemanDispatch(ev: SolEvidence): SolDimensionScore {
  const total = ev.run.total_children;
  if (total === 0) return skipped("dispatch", "no children to assess dispatch accuracy");

  const reDispatched = ev.foreman.redispatch_count;
  const score = clamp01(1.0 - reDispatched / total);
  const confidence: SolScoreConfidence = reDispatched > 0 ? "high" : "medium";
  return dim("dispatch", Number(score.toFixed(4)), confidence, {
    detail: `redispatched=${reDispatched}/${total}`,
  });
}

/**
 * evidence_validation: Heartbeat coverage and completion signals.
 * High heartbeats per child = thorough evidence; low = minimal signal.
 * Score = 1.0 when mean heartbeats ≥ 5 per child.
 */
function scoreForemanEvidenceValidation(ev: SolEvidence): SolDimensionScore {
  const totalHeartbeats = ev.worker.total_heartbeats;
  const totalChildren = ev.children.length;

  if (totalChildren === 0) return skipped("evidence_validation", "no children observed");
  if (totalHeartbeats === 0) return skipped("evidence_validation", "no heartbeat events in telemetry");

  const meanHeartbeats = totalHeartbeats / totalChildren;
  // 5 heartbeats per child = 1.0; scales linearly down to 0 at 1 heartbeat
  const EXPECTED = 5;
  const score = clamp01(Math.min(meanHeartbeats, EXPECTED) / EXPECTED);
  return dim("evidence_validation", Number(score.toFixed(4)), "medium", {
    detail: `mean_heartbeats_per_child=${meanHeartbeats.toFixed(1)}`,
  });
}

/**
 * scope: Out-of-scope escalation events.
 * 0 out-of-scope events = 1.0; each event reduces score.
 */
function scoreForemanScope(ev: SolEvidence): SolDimensionScore {
  const { out_of_scope_count } = ev.intervention;
  const hasEscalationSignal =
    ev.intervention.blocked_event_count > 0 || ev.tokens.total_worker_heartbeats > 0;

  if (!hasEscalationSignal && out_of_scope_count === 0) {
    return skipped("scope", "no worker-blocked events in telemetry");
  }

  const score = clamp01(1.0 - out_of_scope_count * 0.5);
  const confidence: SolScoreConfidence = out_of_scope_count > 0 ? "high" : "medium";
  return dim("scope", Number(score.toFixed(4)), confidence, {
    detail: `out_of_scope_events=${out_of_scope_count}`,
  });
}

/**
 * completion: Fraction of children that completed successfully.
 * Score = workers_succeeded / total_children.
 */
function scoreForemanCompletion(ev: SolEvidence): SolDimensionScore {
  const total = ev.run.total_children;
  if (total === 0) return skipped("completion", "no children observed");

  const succeeded = ev.worker.workers_succeeded;
  const score = clamp01(succeeded / total);
  const confidence: SolScoreConfidence =
    ev.worker.workers_failed > 0 || ev.worker.workers_blocked > 0 ? "high" : "medium";
  return dim("completion", Number(score.toFixed(4)), confidence, {
    detail: `succeeded=${succeeded}/${total}`,
  });
}

/**
 * qc_repair_loop: Observe QC repair loop outcomes.
 *
 * Scores repair loop terminal states without treating provider findings as
 * ground truth. Best outcome = loop passed or no repairable findings.
 * Worst = all providers failed, operator review required, or Medic referral.
 * Skipped when QC is not configured or no repair loop ran.
 */
function scoreForemanQcRepairLoop(ev: SolEvidence): SolDimensionScore {
  if (ev.qc.availability === "future" || ev.qc.availability === "unavailable") {
    return skipped("qc_repair_loop", `QC evidence availability=${ev.qc.availability}`);
  }

  const loop = ev.qc.repair_loop;
  if (!loop) {
    return skipped("qc_repair_loop", "no QC repair loop data available");
  }

  const { status, rounds_completed, max_rounds, packets_compiled, packets_failed, rerun_outcome } = loop;

  switch (status) {
    case "passed":
    case "repaired":
    case "no-repairable":
      return dim("qc_repair_loop", 1.0, "high", {
        detail: `status=${status}, rounds=${rounds_completed}/${max_rounds}, packets=${packets_compiled}, rerun=${rerun_outcome ?? "n/a"}`,
      });
    case "max-rounds":
      return dim("qc_repair_loop", 0.5, "high", {
        detail: `status=${status}, rounds=${rounds_completed}/${max_rounds}, packets=${packets_compiled}`,
      });
    case "all-providers-failed":
    case "operator-review":
    case "medic-referral":
      return dim("qc_repair_loop", 0.0, "high", {
        detail: `status=${status}, failed_packets=${packets_failed}, rerun=${rerun_outcome ?? "n/a"}`,
      });
    case "not-run":
    case "not-configured":
    case "in-progress":
    case "unknown":
    default:
      return skipped("qc_repair_loop", `QC repair loop status=${status}`);
  }
}

/**
 * recovery: State repair detection.
 * Score = 1.0 when no medic/repair artifacts detected; 0.0 when repair required.
 */
function scoreForemanRecovery(ev: SolEvidence): SolDimensionScore {
  const repairRequired = ev.intervention.state_repair_required;
  // We only know repair was required when the cluster dir is inspected.
  // If clusterDir was null, this field defaults to false — treat as low confidence.
  const hasClusterSignal = ev.children.length > 0 || ev.run.cluster_id !== null;
  if (!hasClusterSignal) return skipped("recovery", "no cluster artifact path to assess repair");

  const score = repairRequired ? 0.0 : 1.0;
  const confidence: SolScoreConfidence = repairRequired ? "high" : "low";
  return dim("recovery", score, confidence, {
    detail: `state_repair_required=${repairRequired}`,
  });
}

// ──────────────────────────────────────────────
// Worker dimension scorers (per child)
// ──────────────────────────────────────────────

/**
 * token: Token usage efficiency.
 * Uses tokens_by_child from telemetry. If no per-child token data:
 * falls back to heartbeat_count as a proxy (medium confidence).
 */
function scoreWorkerToken(child: SolChildEvidence, ev: SolEvidence): SolDimensionScore {
  const tokensUsed = ev.tokens.tokens_by_child[child.child_id];
  if (tokensUsed !== undefined) {
    // Per-child token budget: 200k = 1.0, 500k = 0.0
    const BUDGET = 200_000;
    const MAX_PENALIZED = 500_000;
    const score = tokensUsed <= BUDGET
      ? 1.0
      : clamp01(1.0 - (tokensUsed - BUDGET) / (MAX_PENALIZED - BUDGET));
    return dim("token", Number(score.toFixed(4)), "high", { detail: `tokens_used=${tokensUsed}` });
  }

  // Fallback: heartbeat count proxy (low confidence)
  if (child.heartbeat_count > 0) {
    return dim("token", null, "none", {
      skipped_reason: "no per-child token data in heartbeat events; tokens_by_child unavailable",
    });
  }

  return skipped("token", "no token usage evidence available for this child");
}

/**
 * duration: Runtime duration proxy via heartbeat count.
 * Higher heartbeats = longer / more active run.
 * Score = 1.0 at 1–6 heartbeats; penalty above 10 (runaway duration).
 */
function scoreWorkerDuration(child: SolChildEvidence): SolDimensionScore {
  const hb = child.heartbeat_count;
  if (hb === 0) return skipped("duration", "no heartbeat count evidence for this child");

  // Heartbeats > 10 suggest a long/troubled run
  const EXPECTED_MAX = 10;
  const score = hb <= EXPECTED_MAX ? 1.0 : clamp01(1.0 - (hb - EXPECTED_MAX) * 0.05);
  return dim("duration", Number(score.toFixed(4)), "medium", { detail: `heartbeat_count=${hb}` });
}

/**
 * validation: Outcome of the worker's validation commands.
 * Score = 1.0 for "passed", 0.0 for "failed", skipped for "skipped"/"unknown".
 */
function scoreWorkerValidation(child: SolChildEvidence): SolDimensionScore {
  const v = child.validation;
  if (v === "passed") return dim("validation", 1.0, "high", { detail: "validation=passed" });
  if (v === "failed") return dim("validation", 0.0, "high", { detail: "validation=failed" });
  return skipped("validation", `validation outcome is '${v}'`);
}

/**
 * qc: QC findings attributed to this child.
 * Uses per-child weighted score from QC provider signals.
 * When QC is unavailable, dimension is skipped.
 */
function scoreWorkerQc(child: SolChildEvidence, ev: SolEvidence): SolDimensionScore {
  if (ev.qc.availability === "future" || ev.qc.availability === "unavailable") {
    return skipped("qc", `QC evidence availability=${ev.qc.availability}`);
  }

  // Find the child's signal in qc evidence (not directly on ev.qc, but
  // QcScoreSummary's recurring_child_signals is on DiagnosisReport.qc_summary,
  // not SolQcEvidence). We use ev.qc.total_findings as a proxy.
  // Per-child QC attribution is not surfaced in SolEvidence v1 — skipped with note.
  // ponytail: when per-child QC attribution is added to SolEvidence, replace this proxy.
  return skipped("qc", "per-child QC attribution not available in SolEvidence v1; see qc_summary.recurring_child_signals in DiagnosisReport");
}

/**
 * repair_iterations: Escalation count proxy for re-work.
 * 0 escalations = 1.0; each escalation reduces score.
 */
function scoreWorkerRepairIterations(child: SolChildEvidence): SolDimensionScore {
  const esc = child.escalation_count;
  const score = clamp01(1.0 - esc * 0.25);
  const confidence: SolScoreConfidence = esc > 0 ? "high" : "medium";
  return dim("repair_iterations", Number(score.toFixed(4)), confidence, {
    detail: `escalation_count=${esc}`,
  });
}

/**
 * scope_adherence: Out-of-scope blocks detected in telemetry.
 * This is a run-level signal (not per-child in SolEvidence v1).
 * Score = 1.0 when worker didn't raise out-of-scope; 0.0 when it did.
 * Uses the child's next_recommended_action as a fallback signal.
 */
function scoreWorkerScopeAdherence(child: SolChildEvidence, ev: SolEvidence): SolDimensionScore {
  // Check if this child was blocked (out-of-scope)
  if (child.status === "blocked") {
    return dim("scope_adherence", 0.0, "high", { detail: "worker status=blocked" });
  }

  // Check intervention.out_of_scope_count at run level as a proxy
  // (not per-child in v1, but if there are no out-of-scope events at all, this child is clean)
  if (ev.intervention.out_of_scope_count > 0) {
    // Can't attribute to a specific child in v1 — low confidence
    return dim("scope_adherence", 0.5, "low", {
      detail: `run has ${ev.intervention.out_of_scope_count} out-of-scope events; per-child attribution unavailable`,
    });
  }

  // No out-of-scope events in the run and child is not blocked
  const hasTelemetrySignal = ev.tokens.total_worker_heartbeats > 0;
  const confidence: SolScoreConfidence = hasTelemetrySignal ? "medium" : "low";
  return dim("scope_adherence", 1.0, confidence, { detail: "no out-of-scope events observed" });
}

/**
 * acceptance_criteria: Validation commands completed successfully.
 * Mirrors the validation dimension but focused on "did the child meet its
 * acceptance criteria" — uses validation outcome plus status.
 */
function scoreWorkerAcceptanceCriteria(child: SolChildEvidence): SolDimensionScore {
  if (child.status === "done" && child.validation === "passed") {
    return dim("acceptance_criteria", 1.0, "high", {
      detail: "status=done, validation=passed",
    });
  }
  if (child.status === "failed" || child.validation === "failed") {
    return dim("acceptance_criteria", 0.0, "high", {
      detail: `status=${child.status}, validation=${child.validation}`,
    });
  }
  if (child.status === "blocked") {
    return dim("acceptance_criteria", 0.0, "high", { detail: "status=blocked" });
  }
  return skipped("acceptance_criteria", `insufficient evidence: status=${child.status}, validation=${child.validation}`);
}

/**
 * first_pass: Did the worker succeed without foreman/user intervention?
 * Score = 1.0 when user_intervened=false and foreman_intervened=false.
 * Skipped when both are null (not yet scored).
 */
function scoreWorkerFirstPass(child: SolChildEvidence): SolDimensionScore {
  const { user_intervened, foreman_intervened } = child;
  if (user_intervened === null && foreman_intervened === null) {
    return skipped("first_pass", "intervention flags not yet scored (user_intervened=null, foreman_intervened=null)");
  }
  if (user_intervened === true) {
    return dim("first_pass", 0.0, "high", { detail: "user_intervened=true" });
  }
  if (foreman_intervened === true) {
    return dim("first_pass", 0.5, "high", { detail: "foreman_intervened=true" });
  }
  return dim("first_pass", 1.0, "high", { detail: "no user or foreman intervention" });
}

// ──────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────

/**
 * Compute a SOL score report for the Foreman role from aggregated evidence.
 *
 * @param ev — SolEvidence loaded via aggregateSolEvidence
 * @returns SolForemanScoreReport
 */
export function computeForemanScore(ev: SolEvidence): SolForemanScoreReport {
  const tokenDim = scoreForemanToken(ev);
  const durationDim = scoreForemanDuration(ev);
  const interventionDim = scoreForemanIntervention(ev);
  const preAnalysisDim = scoreForemanPreAnalysis(ev);
  const dependencyDim = scoreForemanDependency(ev);
  const dispatchDim = scoreForemanDispatch(ev);
  const evidenceValidationDim = scoreForemanEvidenceValidation(ev);
  const scopeDim = scoreForemanScope(ev);
  const completionDim = scoreForemanCompletion(ev);
  const recoveryDim = scoreForemanRecovery(ev);
  const qcRepairLoopDim = scoreForemanQcRepairLoop(ev);

  const dims = [
    tokenDim, durationDim, interventionDim, preAnalysisDim,
    dependencyDim, dispatchDim, evidenceValidationDim, scopeDim,
    completionDim, recoveryDim, qcRepairLoopDim,
  ];
  const { score: composite_score, confidence: composite_confidence } = composite(dims);

  return {
    composite_score,
    composite_confidence,
    token: tokenDim,
    duration: durationDim,
    intervention: interventionDim,
    pre_analysis: preAnalysisDim,
    dependency: dependencyDim,
    dispatch: dispatchDim,
    evidence_validation: evidenceValidationDim,
    scope: scopeDim,
    completion: completionDim,
    recovery: recoveryDim,
    qc_repair_loop: qcRepairLoopDim,
  };
}

/**
 * Compute a SOL score report for a single Worker child from aggregated evidence.
 *
 * @param childId — The child to score
 * @param ev      — SolEvidence loaded via aggregateSolEvidence
 * @returns SolWorkerScoreReport or null when the child is not found in evidence
 */
export function computeWorkerScore(childId: string, ev: SolEvidence): SolWorkerScoreReport | null {
  const child = ev.children.find((c) => c.child_id === childId);
  if (!child) return null;

  const tokenDim = scoreWorkerToken(child, ev);
  const durationDim = scoreWorkerDuration(child);
  const validationDim = scoreWorkerValidation(child);
  const qcDim = scoreWorkerQc(child, ev);
  const repairIterationsDim = scoreWorkerRepairIterations(child);
  const scopeAdherenceDim = scoreWorkerScopeAdherence(child, ev);
  const acceptanceCriteriaDim = scoreWorkerAcceptanceCriteria(child);
  const firstPassDim = scoreWorkerFirstPass(child);

  const dims = [
    tokenDim, durationDim, validationDim, qcDim, repairIterationsDim,
    scopeAdherenceDim, acceptanceCriteriaDim, firstPassDim,
  ];
  const { score: composite_score, confidence: composite_confidence } = composite(dims);

  return {
    child_id: childId,
    composite_score,
    composite_confidence,
    token: tokenDim,
    duration: durationDim,
    validation: validationDim,
    qc: qcDim,
    repair_iterations: repairIterationsDim,
    scope_adherence: scopeAdherenceDim,
    acceptance_criteria: acceptanceCriteriaDim,
    first_pass: firstPassDim,
  };
}

/**
 * Compute a full SOL score report for a run (Foreman + all Workers).
 *
 * @param ev — SolEvidence loaded via aggregateSolEvidence
 * @returns SolScoreReport
 */
export function computeSolScoreReport(ev: SolEvidence): SolScoreReport {
  const foreman = computeForemanScore(ev);
  const workers: Record<string, SolWorkerScoreReport> = {};

  for (const child of ev.children) {
    const report = computeWorkerScore(child.child_id, ev);
    if (report) workers[child.child_id] = report;
  }

  // Run composite = mean of foreman + all workers
  const composites = [
    foreman.composite_score,
    ...Object.values(workers).map((w) => w.composite_score),
  ].filter((v): v is number => v !== null);

  const run_composite_score =
    composites.length > 0
      ? Number((composites.reduce((s, v) => s + v, 0) / composites.length).toFixed(4))
      : null;

  return {
    run_id: ev.run_id,
    cluster_id: ev.cluster_id,
    scored_at: new Date().toISOString(),
    foreman,
    workers,
    run_composite_score,
  };
}
