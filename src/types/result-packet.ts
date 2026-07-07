/**
 * Result packet types for Polaris worker execution and Medic dispatch.
 */

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
}