/**
 * SOL evidence schema.
 *
 * Typed inputs for the Self-Optimization Loop (SOL) scoring pipeline.
 * These types represent the normalized read model over existing durable
 * run artifacts: state, telemetry, result packets, QC results, and
 * (future) router decision evidence.
 *
 * Design rules:
 *   - All top-level inputs are optional unless the field documents a
 *     required identity key (run_id, cluster_id).
 *   - Future fields from POL-469 (router evidence) and POL-476 (QC
 *     metrics) are marked with an `availability` tag explaining when
 *     they will be populated.
 *   - Nothing in this file mutates run artifacts or triggers side effects.
 */

// ──────────────────────────────────────────────
// Availability sentinel
// ──────────────────────────────────────────────

/**
 * Signals whether an optional evidence field is present, explicitly
 * absent for a known reason, or not yet emitted (future upstream source).
 */
export type EvidenceAvailability = "available" | "unavailable" | "future";

// ──────────────────────────────────────────────
// Grouping keys (dimensions for aggregation / trend analysis)
// ──────────────────────────────────────────────

/**
 * Dimensions used to group evidence records for trend analysis.
 * All fields are optional; populate what can be read from artifacts.
 */
export interface SolGroupingKeys {
  /** Repository identifier (e.g. git remote or package.json name). */
  repo?: string;
  /** Route label from the cluster or worker packet (e.g. "src/loop/**"). */
  route?: string;
  /** Task type (e.g. "implementation", "analysis", "librarian"). */
  task_type?: string;
  /** Worker role (e.g. "worker", "medic", "foreman"). */
  role?: string;
  /** Risk tier for the child or cluster (e.g. "high", "medium", "low"). */
  risk?: string;
  /** Provider name (e.g. "devin", "claude", "codex"). */
  provider?: string;
  /** Model identifier (e.g. "claude-3-7-sonnet", "gpt-4o"). */
  model?: string;
}

// ──────────────────────────────────────────────
// Run-level evidence
// ──────────────────────────────────────────────

/**
 * Evidence extracted from the run-level state artifact
 * (current-state.json and the run directory).
 */
export interface SolRunEvidence {
  run_id: string;
  cluster_id: string | null;
  branch: string | null;
  status: string | null;
  /** Total children in the run (open + completed). */
  total_children: number;
  /** Children completed at observation time. */
  completed_children: number;
  /** Dispatch epoch when available (counts Foreman dispatch cycles). */
  dispatch_epoch: number | null;
  /** Continue epoch when available. */
  continue_epoch: number | null;
  /** ISO 8601 timestamp the state was last written. */
  state_observed_at: string | null;
}

// ──────────────────────────────────────────────
// Child-level evidence (per WorkerResultContract)
// ──────────────────────────────────────────────

/**
 * Per-child evidence derived from WorkerResultContract.
 */
export interface SolChildEvidence {
  child_id: string;
  run_id: string;
  cluster_id: string;
  status: string;
  validation: string;
  commit: string | null;
  next_recommended_action: string;
  role: string;
  provider: string;
  skill_name: string | null;
  /** Hash of the dispatched packet (for deduplication). */
  packet_hash: string;
  worker_id: string;
  escalation_count: number;
  heartbeat_count: number;
  /** Whether the user pushed commits after worker completion. Null = not yet scored. */
  user_intervened: boolean | null;
  /** Whether the Foreman made corrective commits. Null = not yet scored. */
  foreman_intervened: boolean | null;
  /** Files touched by the worker, when available. */
  changed_files: string[];
  /** Dispatch epoch this child was assigned in. */
  dispatch_epoch: number | null;
  /** Grouping key overrides read from the result artifact (if present). */
  grouping_keys: SolGroupingKeys;
}

// ──────────────────────────────────────────────
// Foreman evidence
// ──────────────────────────────────────────────

/**
 * Evidence about the Foreman's coordination behavior for this run,
 * extracted from telemetry and run state.
 */
export interface SolForemanEvidence {
  /** Maximum bootstrap context size observed (combined estimated tokens). */
  max_bootstrap_tokens: number | null;
  /** Whether the bootstrap context exceeded the 150k token budget. */
  over_token_budget: boolean;
  /** Number of re-dispatches (same child dispatched more than once). */
  redispatch_count: number;
  /** Children that were re-dispatched. */
  redispatched_children: string[];
  /** Whether a Foreman corrective commit was detected. */
  foreman_corrective_commit: boolean;
  /** Number of worker-blocked escalation events in telemetry. */
  escalation_events: number;
}

// ──────────────────────────────────────────────
// Worker evidence (aggregate across all children)
// ──────────────────────────────────────────────

/**
 * Aggregate worker evidence across all children in the run.
 */
export interface SolWorkerEvidence {
  /** Total heartbeats emitted across all workers. */
  total_heartbeats: number;
  /** Total escalation count across all workers. */
  total_escalations: number;
  /** Count of workers that completed with status "done". */
  workers_succeeded: number;
  /** Count of workers that completed with status "failed" or "error". */
  workers_failed: number;
  /** Count of workers that completed with status "blocked". */
  workers_blocked: number;
  /** Count of children with validation="failed". */
  validation_failures: number;
  /** Count of children with validation="passed". */
  validation_passes: number;
  /** Count of children where user_intervened=true. */
  user_interventions: number;
  /** Count of children where foreman_intervened=true. */
  foreman_interventions: number;
}

// ──────────────────────────────────────────────
// Router evidence (POL-469 placeholder)
// ──────────────────────────────────────────────

/**
 * Router decision evidence for one routing event.
 *
 * Shape is intentionally minimal for v1. POL-469 will emit durable
 * RouterDecisionEvidence artifacts; when available, this type will be
 * extended to carry per-candidate scores, rejection reasons, and policy
 * rule references.
 */
export interface SolRouterDecisionEvidence {
  child_id: string;
  selected_provider: string | null;
  providers_tried: string[];
  fallback_used: boolean;
  exhausted: boolean;
  exhausted_reason: string | null;
  rejection_reasons: string[];
}

/**
 * Aggregate router evidence for the run.
 *
 * availability: "unavailable" when telemetry contains no provider-selected
 * events. "future" when POL-469 durable router artifacts are expected but
 * not yet written.
 */
export interface SolRouterEvidence {
  availability: EvidenceAvailability;
  total_decisions: number;
  exhausted_decisions: number;
  fallback_attempts: number;
  successful_fallbacks: number;
  /** Per-decision breakdown. Empty when availability !== "available". */
  decisions: SolRouterDecisionEvidence[];
  /** Recurring failure reasons across decisions. */
  recurring_failure_reasons: Array<{ reason: string; occurrences: number; child_ids: string[] }>;
}

// ──────────────────────────────────────────────
// QC evidence (POL-476 placeholder)
// ──────────────────────────────────────────────

/**
 * Aggregate QC evidence for the run.
 *
 * availability: "unavailable" when no QC artifacts exist.
 * "future" when QC is planned but not yet completed for this cluster.
 */
export interface SolQcEvidence {
  availability: EvidenceAvailability;
  qc_run_count: number;
  total_findings: number;
  blocking_findings: number;
  autofixed_findings: number;
  repaired_findings: number;
  waived_findings: number;
  unvalidated_findings: number;
  weighted_open_score: number;
  qc_penalty: number;
  blocks_delivery: boolean;
  open_by_severity: {
    critical: number;
    high: number;
    medium: number;
    low: number;
    info: number;
  };
}

// ──────────────────────────────────────────────
// Validation evidence
// ──────────────────────────────────────────────

/**
 * Per-child validation result extracted from result packets.
 */
export interface SolValidationEvidence {
  child_id: string;
  /** "passed" | "failed" | "skipped" | "unknown" */
  outcome: string;
  /** Validation commands that passed. Empty when outcome !== "passed". */
  passed_commands: string[];
  /** Error context when available. */
  error_message: string | null;
}

// ──────────────────────────────────────────────
// Token / runtime evidence
// ──────────────────────────────────────────────

/**
 * Token and runtime cost evidence for the run.
 */
export interface SolTokenEvidence {
  /** Maximum combined_estimated_tokens seen in bootstrap-context-size events. */
  max_bootstrap_tokens: number | null;
  /** Total worker heartbeat events (proxy for worker runtime activity). */
  total_worker_heartbeats: number;
  /** Token counts per child (when emitted in heartbeat events). */
  tokens_by_child: Record<string, number>;
}

// ──────────────────────────────────────────────
// Intervention / runtime signals
// ──────────────────────────────────────────────

/**
 * Signals from human or Foreman intervention during the run.
 */
export interface SolInterventionEvidence {
  /** Any user_intervened=true flag across children. */
  user_intervened: boolean;
  /** Any foreman_intervened=true flag across children. */
  foreman_intervened: boolean;
  /** Count of worker-blocked events in telemetry. */
  blocked_event_count: number;
  /** Count of out-of-scope worker-blocked events. */
  out_of_scope_count: number;
  /** Whether medic/state-repair artifacts were detected. */
  state_repair_required: boolean;
}

// ──────────────────────────────────────────────
// Composite: full SOL evidence record
// ──────────────────────────────────────────────

/**
 * Full SOL evidence record for one run.
 *
 * This is the normalized read model consumed by SOL evaluation.
 * Loaders populate what is available and mark future fields as
 * "unavailable" or "future".
 */
export interface SolEvidence {
  /** Schema version for forward compatibility. */
  schema_version: "1.0";
  /** Identity. */
  run_id: string;
  cluster_id: string | null;
  /** ISO 8601 timestamp when evidence was loaded. */
  observed_at: string;
  /** Grouping keys for this run (repo, route, task_type, etc.). */
  grouping_keys: SolGroupingKeys;
  /** Run-level state evidence. */
  run: SolRunEvidence;
  /** Per-child evidence from WorkerResultContracts. */
  children: SolChildEvidence[];
  /** Foreman coordination evidence. */
  foreman: SolForemanEvidence;
  /** Aggregate worker evidence. */
  worker: SolWorkerEvidence;
  /** Router decision evidence. */
  router: SolRouterEvidence;
  /** QC aggregate evidence. */
  qc: SolQcEvidence;
  /** Per-child validation evidence. */
  validation: SolValidationEvidence[];
  /** Token and runtime cost evidence. */
  tokens: SolTokenEvidence;
  /** Intervention and runtime signals. */
  intervention: SolInterventionEvidence;
}
