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