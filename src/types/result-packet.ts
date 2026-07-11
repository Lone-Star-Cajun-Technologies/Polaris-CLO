/**
 * Result packet types for Polaris worker execution and Medic dispatch.
 */

// ── Worker run-health symptom types ──────────────────────────────────────────

/**
 * Structured symptom a worker can emit in its sealed result.
 *
 * Workers observe and report; they do NOT diagnose root cause.
 * Use one of the five canonical categories.
 */
export type WorkerSymptomCategory =
  | "worker-blocked"          // Worker could not proceed (missing info, approval needed)
  | "validation-failed"       // Build/test/lint validation commands failed
  | "repeated-rework"         // Worker attempted the same fix multiple times without success
  | "unclear-requirements"    // Requirements are contradictory or too ambiguous to act on
  | "unusual-assumption"      // Worker had to make an assumption outside normal scope

export interface WorkerRunHealthSymptom {
  /** One of the five canonical symptom categories. */
  category: WorkerSymptomCategory;
  /** Human-readable description of what was observed. Keep to one sentence. */
  message: string;
  /**
   * Paths or ids of evidence artifacts (log excerpts, file paths, telemetry ids).
   * Optional — include when evidence is easily referenceable.
   */
  evidence_refs?: string[];
  /** ISO-8601 timestamp when the symptom was first observed. */
  occurred_at: string;
}

// ── Routing anomaly signal types ─────────────────────────────────────────────

/**
 * Routing anomaly signal surfaced by the loop/dispatch boundary or SOL scoring.
 *
 * These are review signals, not routing overrides. They feed Medic and SOL
 * follow-up surfaces without changing provider trust or policy automatically.
 */
export interface RoutingSignal {
  /** Canonical signal name (e.g. "missing-sealed-result"). */
  signal: string;
  /** Human-readable reason for the signal. */
  reason: string;
  /** Number of telemetry events aggregated into this signal. */
  occurrences: number;
  /** Child ids that produced the signal. */
  child_ids: string[];
}

/**
 * Base result packet interface
 */
export interface BaseResultPacket {
  run_id: string;
  child_id: string;
  cluster_id: string;
  status: "success" | "failure";
  timestamp: string;
}

/**
 * Successful result packet
 */
export interface SuccessResultPacket extends BaseResultPacket {
  status: "success";
  validation: {
    passed: string[];
  };
  commit: string;
  error_message?: never;
}

/**
 * Failed result packet
 */
export interface FailedResultPacket extends BaseResultPacket {
  status: "failure";
  error_message: string;
  changed_files?: string[];
  validation_failures?: string[];
  execution_context?: {
    command?: string;
    error_type?: string;
    stack_trace?: string;
  };
  validation?: never;
  commit?: never;
}

/**
 * Union type for result packets
 */
export type ResultPacket = SuccessResultPacket | FailedResultPacket;

/**
 * Type guard for failed result packets
 */
export function isFailedResultPacket(
  packet: ResultPacket,
): packet is FailedResultPacket {
  return packet.status === "failure";
}

/**
 * Medic packet interface
 */
export interface MedicPacket {
  role: "medic";
  run_id: string;
  dispatch_id: string;
  cluster_id: string;
  failed_result_packet: FailedResultPacket;
  cluster_context: {
    branch: string;
    route?: string;
    related_work_items?: string[];
  };
  result_path: string;
  allowed_write_paths: string[];
  prohibited_write_paths: string[];
  telemetry_path?: string;
}

/**
 * Medic result interface
 */
export interface MedicResult {
  run_id: string;
  dispatch_id: string;
  cluster_id: string;
  status: "success" | "partial" | "failure" | "blocked";
  commit_sha: string | null;
  chart_id: string | null;
  diagnosis: {
    root_cause: string;
    repair_strategy: string;
  };
  validation: {
    outcome: "success" | "partial" | "failure";
    build_passed: boolean;
    tests_passed: boolean;
  };
  blockers: string[];
  timestamp: string;
  error_message?: string;
}

/**
 * Medic run-health consult packet.
 *
 * Dispatched by the Foreman when a run has recorded health symptoms and
 * requires a Medic diagnosis before finalization.
 */
export interface MedicRunHealthPacket {
  role: "medic-run-health";
  run_id: string;
  dispatch_id: string;
  cluster_id: string;
  /** Absolute path to the run-health JSON report. */
  run_health_report_path: string;
  /** References to QC/evidence artifacts consulted by Medic. */
  qc_artifact_refs: string[];
  /** Absolute path to the run telemetry JSONL file. */
  telemetry_path: string;
  /** Absolute path to the cluster state snapshot. */
  cluster_state_path: string;
  /** Policy limits governing treatment dispatch. */
  policy_limits: {
    /** Maximum number of treatment rounds before terminal outcome. */
    max_treatment_rounds: number;
  };
  /** Path where Medic must write its sealed result JSON. */
  result_path: string;
  /** Paths Medic may write (charts, treatment packets, sealed result). */
  allowed_write_paths: string[];
  /** Paths Medic must never write. */
  prohibited_write_paths: string[];
}

/**
 * A single symptom recorded on a Medic chart.
 */
export interface MedicChartSymptom {
  id: string;
  code: string;
  message: string;
}

/**
 * Medic chart decision values.
 */
export type MedicChartDecision =
  | "no-treatment-needed"
  | "treatment-required"
  | "terminal";

/**
 * A Medic run-health chart documenting symptoms, diagnosis, and decision.
 */
export interface MedicChart {
  chart_id: string;
  cluster_id: string;
  symptoms: MedicChartSymptom[];
  diagnosis: string;
  evidence_refs: string[];
  decision: MedicChartDecision;
  treatment_plan?: string[];
  no_treatment_rationale?: string;
  follow_up_conditions?: string[];
  created_at: string;
}

/**
 * A treatment packet emitted by Medic and dispatched as a normal worker/repair packet.
 */
export interface MedicTreatmentPacket {
  packet_id: string;
  run_id: string;
  cluster_id: string;
  /** Treatment round number (1-indexed). */
  round: number;
  /** Symptom ids this treatment packet addresses. */
  source_symptom_ids: string[];
  /** Allowed file scope for the treatment worker. */
  allowed_scope: string[];
  /** Paths the treatment worker must not touch. */
  prohibited_scope: string[];
  /** Validation commands the treatment worker must run. */
  validation_commands: string[];
  /** Human-readable diagnosis guiding the treatment worker. */
  root_cause_hint: string;
  /** Dispatch metadata consumed by Foreman. */
  dispatch_metadata: {
    dispatch_id: string;
    worker_id: string;
    /** Absolute path where the treatment worker writes its sealed result. */
    result_file: string;
  };
  /** Current status of the treatment packet. */
  status: "pending" | "in-progress" | "completed" | "failed";
}

/**
 * Result of dispatching a single treatment worker.
 */
export interface TreatmentWorkerResult {
  packet_id: string;
  status: "success" | "failure";
  commit_sha?: string;
  error_message?: string;
}

/**
 * Result of a Medic run-health consult.
 */
export interface MedicRunHealthResult {
  run_id: string;
  cluster_id: string;
  dispatch_id: string;
  status: "resolved" | "blocked" | "error";
  chart_id: string | null;
  decision: MedicChartDecision;
  treatment_packet_refs: string[];
  terminal_outcome?: string;
  error_message?: string;
  timestamp: string;
}

/**
 * Role Evidence Contract — standardized fields every Polaris role session
 * (Worker, Foreman, Analyst, Librarian, Medic) must emit to be eligible for
 * retroactive autoresearch scoring. v1 captures the durable artifact pointers
 * and dispatch context that the scoring pipeline consumes later.
 */
export interface WorkerResultContract {
  /** Identifiers */
  child_id: string;
  run_id: string;
  cluster_id: string;

  /** Outcome */
  status: "done" | "failed" | "blocked" | "error";
  validation: "passed" | "failed" | "skipped";
  commit: string | null;
  next_recommended_action: "continue" | "stop" | "investigate";

  /** Role and execution context */
  role: string;
  provider: string;
  skill_name: string | null;

  /** Dispatch evidence */
  packet_hash: string;
  worker_id: string;
  escalation_count: number;
  heartbeat_count: number;

  /** Artifact paths */
  result_artifact_path: string;
  packet_path: string;
  telemetry_path: string;

  /** Intervention flags — scored retroactively, emitted as null in v1 */
  user_intervened: boolean | null;
  foreman_intervened: boolean | null;

  /** Polaris-dev-only scoring context (optional/null in v1) */
  dispatch_epoch?: number;
  session_pointer?: string | null;

  /**
   * Files this worker changed, when available.
   * Used by QC attribution to correlate findings back to the worker that
   * touched the relevant lines.
   */
  changed_files?: string[];

  /** Optional free-form results from the child execution. */
  result_data?: Record<string, unknown>;

  /**
   * Structured run-health symptoms observed during worker execution.
   * Present only when at least one symptom occurred. Workers report symptoms
   * without diagnosing root cause — diagnosis is Medic's responsibility.
   */
  run_health_symptoms?: WorkerRunHealthSymptom[];
}