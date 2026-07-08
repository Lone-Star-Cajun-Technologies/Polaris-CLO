/**
 * SOL evidence loader.
 *
 * Aggregates existing durable run artifacts into a SolEvidence record
 * without mutating any artifact. Reads from RunArtifacts (already loaded
 * by loadRunArtifacts) and maps each field to the normalized SOL schema.
 *
 * Design rules:
 *   - Never throws on missing data — tolerate absent fields gracefully.
 *   - Future router/QC fields (POL-469, POL-476) are marked "future" when
 *     the source system is known but artifacts haven't been written yet.
 *   - All file I/O is delegated to loadRunArtifacts; this module is pure
 *     aggregation over what was already loaded.
 */

import { existsSync, readdirSync } from "node:fs";
import type { RunArtifacts } from "./score.js";
import { computeQcSummary } from "./score.js";
import type {
  SolEvidence,
  SolGroupingKeys,
  SolRunEvidence,
  SolChildEvidence,
  SolForemanEvidence,
  SolWorkerEvidence,
  SolRouterEvidence,
  SolQcEvidence,
  SolValidationEvidence,
  SolTokenEvidence,
  SolInterventionEvidence,
} from "../types/sol-evidence.js";
import type { WorkerResultContract } from "../types/result-packet.js";

// ──────────────────────────────────────────────
// Internal helpers
// ──────────────────────────────────────────────

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function asNumber(v: unknown): number | null {
  return typeof v === "number" ? v : null;
}

function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

// ──────────────────────────────────────────────
// Run evidence
// ──────────────────────────────────────────────

function buildRunEvidence(artifacts: RunArtifacts): SolRunEvidence {
  const state = asRecord(artifacts.currentState);

  const clusterId = asString(state?.["cluster_id"]);
  const branch = asString(state?.["branch"]);
  const status = asString(state?.["status"]);
  const openChildren = asStringArray(state?.["open_children"]);
  const completedChildren = asStringArray(state?.["completed_children"]);
  const dispatchBoundary = asRecord(state?.["dispatch_boundary"]);
  const dispatchEpoch = asNumber(dispatchBoundary?.["dispatch_epoch"]);
  const continueEpoch = asNumber(dispatchBoundary?.["continue_epoch"]);

  return {
    run_id: artifacts.runId,
    cluster_id: clusterId,
    branch,
    status,
    total_children: openChildren.length + completedChildren.length,
    completed_children: completedChildren.length,
    dispatch_epoch: dispatchEpoch,
    continue_epoch: continueEpoch,
    state_observed_at: null,
  };
}

// ──────────────────────────────────────────────
// Child evidence
// ──────────────────────────────────────────────

function buildChildGroupingKeys(contract: WorkerResultContract): SolGroupingKeys {
  const resultData = asRecord(contract.result_data);
  return {
    role: contract.role ?? undefined,
    provider: contract.provider ?? undefined,
    route: asString(resultData?.["route"]) ?? undefined,
    task_type: asString(resultData?.["task_type"]) ?? undefined,
    risk: asString(resultData?.["risk"]) ?? undefined,
    model: asString(resultData?.["model"]) ?? undefined,
  };
}

function buildChildEvidence(contracts: WorkerResultContract[]): SolChildEvidence[] {
  return contracts.map((c) => ({
    child_id: c.child_id,
    run_id: c.run_id,
    cluster_id: c.cluster_id,
    status: c.status,
    validation: c.validation,
    commit: c.commit ?? null,
    next_recommended_action: c.next_recommended_action,
    role: c.role,
    provider: c.provider,
    skill_name: c.skill_name,
    packet_hash: c.packet_hash,
    worker_id: c.worker_id,
    escalation_count: c.escalation_count,
    heartbeat_count: c.heartbeat_count,
    user_intervened: c.user_intervened ?? null,
    foreman_intervened: c.foreman_intervened ?? null,
    changed_files: c.changed_files ?? [],
    dispatch_epoch: asNumber(c.dispatch_epoch) ?? null,
    grouping_keys: buildChildGroupingKeys(c),
  }));
}

// ──────────────────────────────────────────────
// Foreman evidence
// ──────────────────────────────────────────────

function buildForemanEvidence(artifacts: RunArtifacts): SolForemanEvidence {
  // Bootstrap token budget
  const sizeEvents = artifacts.telemetryEvents
    .map(asRecord)
    .filter((e): e is Record<string, unknown> => e !== undefined && e["event"] === "bootstrap-context-size");

  const tokenValues = sizeEvents
    .map((e) => asNumber(e["combined_estimated_tokens"]))
    .filter((v): v is number => v !== null);

  const maxBootstrapTokens = tokenValues.length > 0 ? Math.max(...tokenValues) : null;
  const overTokenBudget = maxBootstrapTokens !== null && maxBootstrapTokens > 150_000;

  // Re-dispatch detection from per-child dispatch counts in ledger telemetry
  const ledgerCounts = new Map<string, number>();
  for (const ev of artifacts.ledgerEvents) {
    const rec = asRecord(ev);
    if (rec?.["event"] === "child-dispatched" && typeof rec["issue_id"] === "string") {
      const cid = rec["issue_id"];
      ledgerCounts.set(cid, (ledgerCounts.get(cid) ?? 0) + 1);
    }
  }
  const telemetryCounts = new Map<string, number>();
  for (const ev of artifacts.telemetryEvents) {
    const rec = asRecord(ev);
    if (rec?.["event"] === "child-dispatched" && typeof rec["child_id"] === "string") {
      const cid = rec["child_id"];
      telemetryCounts.set(cid, (telemetryCounts.get(cid) ?? 0) + 1);
    }
  }
  const allCounts = new Map<string, number>();
  for (const [cid, count] of ledgerCounts) allCounts.set(cid, Math.max(allCounts.get(cid) ?? 0, count));
  for (const [cid, count] of telemetryCounts) allCounts.set(cid, Math.max(allCounts.get(cid) ?? 0, count));
  const redispatchedChildren = Array.from(allCounts.entries())
    .filter(([, count]) => count > 1)
    .map(([cid]) => cid)
    .sort();

  // Foreman corrective commit
  const foremanCorrectiveCommit = artifacts.workerResultContracts.some((c) => c.foreman_intervened === true);

  // Escalation events
  const escalationEvents = artifacts.telemetryEvents.filter((ev) => {
    const rec = asRecord(ev);
    return rec?.["event"] === "escalation-initiated";
  }).length;

  return {
    max_bootstrap_tokens: maxBootstrapTokens,
    over_token_budget: overTokenBudget,
    redispatch_count: redispatchedChildren.length,
    redispatched_children: redispatchedChildren,
    foreman_corrective_commit: foremanCorrectiveCommit,
    escalation_events: escalationEvents,
  };
}

// ──────────────────────────────────────────────
// Worker evidence (aggregate)
// ──────────────────────────────────────────────

function buildWorkerEvidence(contracts: WorkerResultContract[]): SolWorkerEvidence {
  let totalHeartbeats = 0;
  let totalEscalations = 0;
  let succeeded = 0;
  let failed = 0;
  let blocked = 0;
  let validationFailed = 0;
  let validationPassed = 0;
  let userInterventions = 0;
  let foremanInterventions = 0;

  for (const c of contracts) {
    totalHeartbeats += c.heartbeat_count;
    totalEscalations += c.escalation_count;

    const status = c.status;
    if (status === "done") succeeded++;
    else if (status === "failed" || status === "error") failed++;
    else if (status === "blocked") blocked++;

    const validation = c.validation;
    if (validation === "passed") validationPassed++;
    else if (validation === "failed") validationFailed++;

    if (c.user_intervened === true) userInterventions++;
    if (c.foreman_intervened === true) foremanInterventions++;
  }

  return {
    total_heartbeats: totalHeartbeats,
    total_escalations: totalEscalations,
    workers_succeeded: succeeded,
    workers_failed: failed,
    workers_blocked: blocked,
    validation_failures: validationFailed,
    validation_passes: validationPassed,
    user_interventions: userInterventions,
    foreman_interventions: foremanInterventions,
  };
}

// ──────────────────────────────────────────────
// Router evidence
// ──────────────────────────────────────────────

function buildRouterEvidence(artifacts: RunArtifacts): SolRouterEvidence {
  const telemetry = artifacts.telemetryEvents
    .map(asRecord)
    .filter((e): e is Record<string, unknown> => e !== undefined);

  const selectedEvents = telemetry.filter((e) => e["event"] === "provider-selected");
  const exhaustedEvents = telemetry.filter((e) => e["event"] === "provider-exhausted");
  const fallbackEvents = telemetry.filter((e) => e["event"] === "provider-fallback-attempted");

  // No router telemetry at all → future (this is normal before POL-469 lands)
  if (selectedEvents.length === 0 && exhaustedEvents.length === 0 && fallbackEvents.length === 0) {
    return {
      availability: "future",
      total_decisions: 0,
      exhausted_decisions: 0,
      fallback_attempts: 0,
      successful_fallbacks: 0,
      decisions: [],
      recurring_failure_reasons: [],
    };
  }

  // Build per-decision records
  const decisions = selectedEvents.map((ev) => {
    const childId = asString(ev["child_id"]) ?? "";
    const selectedProvider = asString(ev["selected_provider"]);
    const providersTried = asStringArray(ev["providers_tried"]);
    const exhaustedReason = asString(ev["router_exhausted_reason"]);
    const exhausted = selectedProvider === null;
    const fallbackUsed = selectedProvider !== null && providersTried.length > 1;

    const candidates = Array.isArray(ev["router_candidates"]) ? ev["router_candidates"] : [];
    const rejectionReasons = candidates
      .flatMap((c) => asStringArray(asRecord(c)?.["rejection_reasons"]));

    return {
      child_id: childId,
      selected_provider: selectedProvider,
      providers_tried: providersTried,
      fallback_used: fallbackUsed,
      exhausted,
      exhausted_reason: exhaustedReason,
      rejection_reasons: rejectionReasons,
    };
  });

  // Successful fallbacks
  const childCompletionStatus = new Map<string, string>();
  for (const ev of telemetry) {
    if (ev["event"] !== "child-complete" || typeof ev["child_id"] !== "string") continue;
    childCompletionStatus.set(
      ev["child_id"],
      typeof ev["completion_status"] === "string" ? ev["completion_status"] : "done",
    );
  }
  let successfulFallbacks = 0;
  for (const d of decisions) {
    if (!d.fallback_used) continue;
    const cs = childCompletionStatus.get(d.child_id);
    if (cs && cs !== "blocked" && cs !== "error") successfulFallbacks++;
  }

  // Recurring failure reasons
  const reasonMap = new Map<string, { count: number; childIds: Set<string> }>();
  const countReason = (reason: string, childId?: string): void => {
    const entry = reasonMap.get(reason) ?? { count: 0, childIds: new Set() };
    entry.count++;
    if (childId) entry.childIds.add(childId);
    reasonMap.set(reason, entry);
  };
  for (const ev of exhaustedEvents) {
    const reason = asString(ev["reason"]) ?? "no-provider-selected";
    countReason(reason, asString(ev["child_id"]) ?? undefined);
  }
  for (const d of decisions) {
    if (!d.exhausted) continue;
    for (const r of d.rejection_reasons) countReason(r, d.child_id);
    if (d.rejection_reasons.length === 0 && d.exhausted_reason) {
      countReason(d.exhausted_reason, d.child_id);
    }
  }
  const recurringFailureReasons = Array.from(reasonMap.entries())
    .map(([reason, v]) => ({ reason, occurrences: v.count, child_ids: Array.from(v.childIds).sort() }))
    .sort((a, b) => b.occurrences - a.occurrences || a.reason.localeCompare(b.reason));

  return {
    availability: "available",
    total_decisions: selectedEvents.length,
    exhausted_decisions: exhaustedEvents.length,
    fallback_attempts: fallbackEvents.length,
    successful_fallbacks: successfulFallbacks,
    decisions,
    recurring_failure_reasons: recurringFailureReasons,
  };
}

// ──────────────────────────────────────────────
// QC evidence
// ──────────────────────────────────────────────

function buildQcEvidence(artifacts: RunArtifacts): SolQcEvidence {
  const disabledOutcome = artifacts.clusterState?.qc_repair_outcome;
  const isDisabled = disabledOutcome === "qc-disabled";

  if (artifacts.qcResults.length === 0) {
    const base = {
      availability: isDisabled ? ("unavailable" as const) : ("future" as const),
      qc_run_count: 0,
      total_findings: 0,
      blocking_findings: 0,
      autofixed_findings: 0,
      repaired_findings: 0,
      waived_findings: 0,
      unvalidated_findings: 0,
      weighted_open_score: 0,
      qc_penalty: 0,
      blocks_delivery: false,
      open_by_severity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
      provider_breakdown: {},
      repair_loop: {
        status: isDisabled ? ("not-configured" as const) : ("not-run" as const),
        rounds_completed: 0,
        max_rounds: 0,
        packets_compiled: 0,
        packets_completed: 0,
        packets_failed: 0,
        rerun_outcome: null,
        provider_attempts: {
          total: 0,
          success: 0,
          failure: 0,
          fallback: 0,
          skipped: 0,
          all_providers_failed: false,
        },
      } as SolQcEvidence["repair_loop"],
      noisy_providers: [],
      has_repair_failures: false,
      unresolved_high_severity: 0,
      max_round_exhausted: false,
    };
    return base;
  }

  const summary = computeQcSummary(
    artifacts.qcResults,
    artifacts.clusterState,
    artifacts.telemetryEvents,
    artifacts.currentState,
  );
  if (!summary) {
    // computeQcSummary only returns null when qcResults is empty; handled above.
    // ponytail: defensive branch to satisfy type narrowing
    return {
      availability: "unavailable",
      qc_run_count: 0,
      total_findings: 0,
      blocking_findings: 0,
      autofixed_findings: 0,
      repaired_findings: 0,
      waived_findings: 0,
      unvalidated_findings: 0,
      weighted_open_score: 0,
      qc_penalty: 0,
      blocks_delivery: false,
      open_by_severity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
      provider_breakdown: {},
      repair_loop: null,
      noisy_providers: [],
      has_repair_failures: false,
      unresolved_high_severity: 0,
      max_round_exhausted: false,
    };
  }

  return {
    availability: "available",
    qc_run_count: summary.qc_run_count,
    total_findings: summary.total_findings,
    blocking_findings: summary.blocking_findings,
    autofixed_findings: summary.autofixed_findings,
    repaired_findings: summary.repaired_findings,
    waived_findings: summary.waived_findings,
    unvalidated_findings: summary.unvalidated_findings,
    weighted_open_score: summary.weighted_open_score,
    qc_penalty: summary.qc_penalty,
    blocks_delivery: summary.blocks_delivery,
    open_by_severity: { ...summary.open_by_severity },
    provider_breakdown: { ...summary.provider_breakdown },
    repair_loop: summary.repair_loop,
    noisy_providers: [...summary.noisy_providers],
    has_repair_failures: summary.has_repair_failures,
    unresolved_high_severity: summary.unresolved_high_severity,
    max_round_exhausted: summary.max_round_exhausted,
  };
}

// ──────────────────────────────────────────────
// Validation evidence
// ──────────────────────────────────────────────

function buildValidationEvidence(contracts: WorkerResultContract[]): SolValidationEvidence[] {
  return contracts.map((c) => {
    const validation = c.validation;
    const outcome = typeof validation === "string" ? validation : "unknown";
    // result_data may carry validation details from the sealed result packet
    const resultData = asRecord(c.result_data);
    const passedCommands = asStringArray(
      asRecord(resultData?.["validation"])?.["passed"] ?? resultData?.["passed_commands"],
    );
    const errorMessage = asString(resultData?.["error_message"]);

    return {
      child_id: c.child_id,
      outcome,
      passed_commands: passedCommands,
      error_message: errorMessage,
    };
  });
}

// ──────────────────────────────────────────────
// Token evidence
// ──────────────────────────────────────────────

function buildTokenEvidence(artifacts: RunArtifacts): SolTokenEvidence {
  const sizeEvents = artifacts.telemetryEvents
    .map(asRecord)
    .filter((e): e is Record<string, unknown> => e !== undefined && e["event"] === "bootstrap-context-size");

  const tokenValues = sizeEvents
    .map((e) => asNumber(e["combined_estimated_tokens"]))
    .filter((v): v is number => v !== null);

  const maxBootstrapTokens = tokenValues.length > 0 ? Math.max(...tokenValues) : null;

  const heartbeatEvents = artifacts.telemetryEvents
    .map(asRecord)
    .filter((e): e is Record<string, unknown> => e !== undefined && e["event"] === "worker-heartbeat");

  const tokensByChild: Record<string, number> = {};
  for (const ev of heartbeatEvents) {
    const childId = asString(ev["child_id"]);
    const tokens = asNumber(ev["tokens_used"]);
    if (childId && tokens !== null) {
      tokensByChild[childId] = (tokensByChild[childId] ?? 0) + tokens;
    }
  }

  return {
    max_bootstrap_tokens: maxBootstrapTokens,
    total_worker_heartbeats: heartbeatEvents.length,
    tokens_by_child: tokensByChild,
  };
}

// ──────────────────────────────────────────────
// Intervention evidence
// ──────────────────────────────────────────────

function buildInterventionEvidence(artifacts: RunArtifacts): SolInterventionEvidence {
  const userIntervened = artifacts.workerResultContracts.some((c) => c.user_intervened === true);
  const foremanIntervened = artifacts.workerResultContracts.some((c) => c.foreman_intervened === true);

  const blockedEvents = artifacts.telemetryEvents.filter((ev) => {
    const rec = asRecord(ev);
    return rec?.["event"] === "worker-blocked";
  });

  const outOfScopeCount = blockedEvents.filter((ev) => {
    const rec = asRecord(ev);
    return rec?.["approval_type"] === "out-of-scope";
  }).length;

  // Medic state-repair detection from cluster directory (mirrors gateStateRepairRequired)
  let stateRepairRequired = false;
  if (artifacts.clusterDir && existsSync(artifacts.clusterDir)) {
    const files = (() => {
      try { return readdirSync(artifacts.clusterDir); } catch { return []; }
    })();
    stateRepairRequired = files.some(
      (f) => f.startsWith("CHART-") || f.startsWith("medic-result-") || (f.includes("medic") && f.endsWith(".json")),
    );
  }

  return {
    user_intervened: userIntervened,
    foreman_intervened: foremanIntervened,
    blocked_event_count: blockedEvents.length,
    out_of_scope_count: outOfScopeCount,
    state_repair_required: stateRepairRequired,
  };
}

// ──────────────────────────────────────────────
// Grouping keys from run state
// ──────────────────────────────────────────────

function buildRunGroupingKeys(artifacts: RunArtifacts): SolGroupingKeys {
  const state = asRecord(artifacts.currentState);
  // Try to read grouping keys from run state if a consumer sets them.
  // In v1 these are typically absent; workers may set them via result_data.
  return {
    repo: asString(state?.["repo"]) ?? undefined,
    route: asString(state?.["route"]) ?? undefined,
    task_type: asString(state?.["task_type"]) ?? undefined,
    role: asString(state?.["role"]) ?? undefined,
    risk: asString(state?.["risk"]) ?? undefined,
    provider: asString(state?.["provider"]) ?? undefined,
    model: asString(state?.["model"]) ?? undefined,
  };
}

// ──────────────────────────────────────────────
// Main entry point
// ──────────────────────────────────────────────

/**
 * Aggregate existing run artifacts into a normalized SolEvidence record.
 *
 * Does not mutate any artifact. Tolerate absent future router/QC fields
 * by marking them "future" rather than throwing.
 *
 * @param artifacts — already-loaded RunArtifacts (from loadRunArtifacts)
 * @returns SolEvidence
 */
export function aggregateSolEvidence(artifacts: RunArtifacts): SolEvidence {
  const children = buildChildEvidence(artifacts.workerResultContracts);

  return {
    schema_version: "1.0",
    run_id: artifacts.runId,
    cluster_id:
      artifacts.currentState &&
      typeof artifacts.currentState === "object" &&
      !Array.isArray(artifacts.currentState)
        ? (asString((artifacts.currentState as Record<string, unknown>)["cluster_id"]))
        : null,
    observed_at: new Date().toISOString(),
    grouping_keys: buildRunGroupingKeys(artifacts),
    run: buildRunEvidence(artifacts),
    children,
    foreman: buildForemanEvidence(artifacts),
    worker: buildWorkerEvidence(artifacts.workerResultContracts),
    router: buildRouterEvidence(artifacts),
    qc: buildQcEvidence(artifacts),
    validation: buildValidationEvidence(artifacts.workerResultContracts),
    tokens: buildTokenEvidence(artifacts),
    intervention: buildInterventionEvidence(artifacts),
  };
}
