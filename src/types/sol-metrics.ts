/**
 * SOL raw metric event contracts.
 *
 * Typed contracts for the raw metric events that the SOL scoring pipeline
 * distinguishes when building evidence and scorecards. These types name the
 * six metric categories defined in the POL-487 acceptance criteria:
 *
 *   1. Provider startup failure
 *   2. Router fallback
 *   3. Worker execution failure
 *   4. Validation failure
 *   5. QC findings
 *   6. User / Foreman intervention
 *
 * These are read-model types — they normalize the raw telemetry events and
 * result packet signals into a typed contract that scoring functions consume.
 * Nothing in this file writes to artifacts or triggers side effects.
 *
 * Relationship to SolEvidence:
 *   SolMetricEvent records are materialized by the evidence loader into the
 *   SolEvidence structure. The SolEvidence fields (foreman, worker, router,
 *   qc, intervention) already carry the aggregated versions; these typed
 *   event contracts let callers reason about individual metric records and
 *   construct per-scope scorecards.
 */

// ──────────────────────────────────────────────
// Metric category discriminant
// ──────────────────────────────────────────────

/**
 * The category of a SOL metric event.
 *
 * Each category maps to a distinct behavioral signal that scorecards
 * score independently.
 */
export type SolMetricCategory =
  | "provider-startup-failure"
  | "router-fallback"
  | "worker-execution-failure"
  | "validation-failure"
  | "qc-finding"
  | "user-intervention"
  | "foreman-intervention";

// ──────────────────────────────────────────────
// Base metric event
// ──────────────────────────────────────────────

/** Fields common to all SOL metric events. */
export interface SolMetricEventBase {
  /** Discriminant category. */
  category: SolMetricCategory;
  /** Run this event belongs to. */
  run_id: string;
  /** Child this event is attributed to, when applicable. */
  child_id?: string;
  /** ISO 8601 timestamp of the originating telemetry event. */
  timestamp?: string;
}

// ──────────────────────────────────────────────
// 1. Provider startup failure
// ──────────────────────────────────────────────

/**
 * A provider failed to start or respond for a dispatched child.
 *
 * Source: telemetry "provider-exhausted" event or result packet status="failed"
 * combined with a provider-side error.
 */
export interface SolProviderStartupFailureEvent extends SolMetricEventBase {
  category: "provider-startup-failure";
  /** Provider that failed to start. */
  provider: string;
  /** Human-readable failure reason from telemetry or result packet. */
  failure_reason: string | null;
  /** Providers that were tried before exhaustion. */
  providers_tried: string[];
  /** Whether all providers were exhausted (no fallback succeeded). */
  all_providers_exhausted: boolean;
}

// ──────────────────────────────────────────────
// 2. Router fallback
// ──────────────────────────────────────────────

/**
 * The worker router used a fallback provider for a dispatched child.
 *
 * Source: telemetry "provider-fallback-attempted" or "provider-selected"
 * with providers_tried.length > 1.
 */
export interface SolRouterFallbackEvent extends SolMetricEventBase {
  category: "router-fallback";
  /** Provider that was originally selected. */
  original_provider: string | null;
  /** Fallback provider actually used. */
  fallback_provider: string | null;
  /** All providers tried in order. */
  providers_tried: string[];
  /** Whether the fallback resulted in a successful child completion. */
  fallback_succeeded: boolean;
  /** Rejection reasons from the router candidates. */
  rejection_reasons: string[];
}

// ──────────────────────────────────────────────
// 3. Worker execution failure
// ──────────────────────────────────────────────

/**
 * A worker child failed during execution (not provider startup).
 *
 * Source: result packet status="failed"|"error", child status="failed".
 * Distinct from provider startup failure: the worker ran but produced
 * a failure outcome.
 */
export interface SolWorkerExecutionFailureEvent extends SolMetricEventBase {
  category: "worker-execution-failure";
  /** Worker status from the result packet (e.g. "failed", "error"). */
  worker_status: string;
  /** Validation outcome from the result packet (e.g. "failed", "unknown"). */
  validation: string;
  /** Provider that executed the worker. */
  provider: string;
  /** Error message from the result packet, when available. */
  error_message: string | null;
  /** Whether the worker raised an out-of-scope escalation before failing. */
  out_of_scope_escalation: boolean;
  /** Number of escalation events attributed to this child. */
  escalation_count: number;
}

// ──────────────────────────────────────────────
// 4. Validation failure
// ──────────────────────────────────────────────

/**
 * A worker child completed but failed its validation commands.
 *
 * Source: result packet validation="failed" or validation.passed=[] with
 * an error_message. Distinct from worker execution failure: the worker
 * finished but did not pass its acceptance checks.
 */
export interface SolValidationFailureEvent extends SolMetricEventBase {
  category: "validation-failure";
  /** Child status from the result packet (e.g. "done", "failed"). */
  worker_status: string;
  /** Validation commands that failed, when available. */
  failed_commands: string[];
  /** Validation commands that passed before the failure. */
  passed_commands: string[];
  /** Error context, when available. */
  error_message: string | null;
}

// ──────────────────────────────────────────────
// 5. QC finding
// ──────────────────────────────────────────────

/**
 * A QC finding attributed to a worker child or cluster.
 *
 * Source: QC artifact findings under .polaris/clusters/<id>/qc/.
 * The finding is advisory input to scorecard computation; SOL does not
 * treat QC findings as ground truth.
 */
export interface SolQcFindingEvent extends SolMetricEventBase {
  category: "qc-finding";
  /** QC provider that emitted this finding. */
  qc_provider: string;
  /** Severity level: "critical"|"high"|"medium"|"low"|"info". */
  severity: "critical" | "high" | "medium" | "low" | "info";
  /** Whether this finding blocks delivery. */
  blocking: boolean;
  /** Whether the finding was auto-fixed. */
  autofixed: boolean;
  /** Whether the finding was repaired by a repair worker. */
  repaired: boolean;
  /** Whether the finding was waived. */
  waived: boolean;
  /** Whether the finding is unvalidated (provider noise candidate). */
  unvalidated: boolean;
  /** Human-readable finding summary. */
  summary: string | null;
  /** Attribution confidence for this finding: "high"|"medium"|"low"|"none". */
  attribution_confidence: "high" | "medium" | "low" | "none";
}

// ──────────────────────────────────────────────
// 6. User / Foreman intervention
// ──────────────────────────────────────────────

/**
 * A user or Foreman made a corrective action after a worker completed.
 *
 * Source: result packet user_intervened=true / foreman_intervened=true,
 * or telemetry "worker-blocked" events with approval_type="out-of-scope".
 */
export interface SolInterventionEvent extends SolMetricEventBase {
  category: "user-intervention" | "foreman-intervention";
  /** Type of actor: "user" or "foreman". */
  actor: "user" | "foreman";
  /**
   * Type of intervention:
   * - "commit"       : corrective commit made after worker completion.
   * - "out-of-scope" : worker raised an out-of-scope escalation requiring approval.
   * - "state-repair" : medic or state-repair artifacts detected in the cluster.
   * - "unspecified"  : intervention flag set but type not further specified.
   */
  intervention_type: "commit" | "out-of-scope" | "state-repair" | "unspecified";
  /** Child this intervention was attributed to. */
  child_id?: string;
  /** Whether the intervention was resolved without blocking delivery. */
  resolved: boolean;
}

// ──────────────────────────────────────────────
// Union type
// ──────────────────────────────────────────────

/**
 * Union of all SOL metric event types.
 *
 * Discriminate on `category` to narrow to the specific subtype.
 */
export type SolMetricEvent =
  | SolProviderStartupFailureEvent
  | SolRouterFallbackEvent
  | SolWorkerExecutionFailureEvent
  | SolValidationFailureEvent
  | SolQcFindingEvent
  | SolInterventionEvent;

// ──────────────────────────────────────────────
// Type guards
// ──────────────────────────────────────────────

export function isProviderStartupFailure(e: SolMetricEvent): e is SolProviderStartupFailureEvent {
  return e.category === "provider-startup-failure";
}

export function isRouterFallback(e: SolMetricEvent): e is SolRouterFallbackEvent {
  return e.category === "router-fallback";
}

export function isWorkerExecutionFailure(e: SolMetricEvent): e is SolWorkerExecutionFailureEvent {
  return e.category === "worker-execution-failure";
}

export function isValidationFailure(e: SolMetricEvent): e is SolValidationFailureEvent {
  return e.category === "validation-failure";
}

export function isQcFinding(e: SolMetricEvent): e is SolQcFindingEvent {
  return e.category === "qc-finding";
}

export function isIntervention(e: SolMetricEvent): e is SolInterventionEvent {
  return e.category === "user-intervention" || e.category === "foreman-intervention";
}

// ──────────────────────────────────────────────
// Metric summary (aggregate counts per category)
// ──────────────────────────────────────────────

/**
 * Aggregated metric event counts for a run or window.
 *
 * Produced by summarizing a list of SolMetricEvent records.
 * Used to populate SolScorecardRawMetrics without exposing the raw event list.
 */
export interface SolMetricSummary {
  /** Total provider startup failures. */
  provider_startup_failures: number;
  /** Total router fallback events. */
  router_fallbacks: number;
  /** Total router fallbacks that succeeded. */
  router_fallback_successes: number;
  /** Total worker execution failures. */
  worker_execution_failures: number;
  /** Total validation failures. */
  validation_failures: number;
  /** Total QC findings (all severity/status). */
  qc_findings_total: number;
  /** QC findings that are blocking. */
  qc_findings_blocking: number;
  /** QC findings that are unvalidated noise candidates. */
  qc_findings_unvalidated: number;
  /** User intervention events. */
  user_interventions: number;
  /** Foreman intervention events. */
  foreman_interventions: number;
}

/**
 * Compute a SolMetricSummary from a list of metric events.
 */
export function summarizeMetricEvents(events: SolMetricEvent[]): SolMetricSummary {
  let providerStartupFailures = 0;
  let routerFallbacks = 0;
  let routerFallbackSuccesses = 0;
  let workerExecutionFailures = 0;
  let validationFailures = 0;
  let qcFindingsTotal = 0;
  let qcFindingsBlocking = 0;
  let qcFindingsUnvalidated = 0;
  let userInterventions = 0;
  let foremanInterventions = 0;

  for (const e of events) {
    if (isProviderStartupFailure(e)) providerStartupFailures++;
    else if (isRouterFallback(e)) {
      routerFallbacks++;
      if (e.fallback_succeeded) routerFallbackSuccesses++;
    } else if (isWorkerExecutionFailure(e)) workerExecutionFailures++;
    else if (isValidationFailure(e)) validationFailures++;
    else if (isQcFinding(e)) {
      qcFindingsTotal++;
      if (e.blocking) qcFindingsBlocking++;
      if (e.unvalidated) qcFindingsUnvalidated++;
    } else if (isIntervention(e)) {
      if (e.actor === "user") userInterventions++;
      else foremanInterventions++;
    }
  }

  return {
    provider_startup_failures: providerStartupFailures,
    router_fallbacks: routerFallbacks,
    router_fallback_successes: routerFallbackSuccesses,
    worker_execution_failures: workerExecutionFailures,
    validation_failures: validationFailures,
    qc_findings_total: qcFindingsTotal,
    qc_findings_blocking: qcFindingsBlocking,
    qc_findings_unvalidated: qcFindingsUnvalidated,
    user_interventions: userInterventions,
    foreman_interventions: foremanInterventions,
  };
}
