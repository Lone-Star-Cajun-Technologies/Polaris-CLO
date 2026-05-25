export type RunStatus = "not-started" | "running" | "stopped" | "complete";

export interface CurrentState {
  schema_version: string;
  run_id: string;
  cluster_id: string;
  active_child: string | null;
  completed_children: string[];
  open_children: string[];
  step_cursor: string;
  context_budget: {
    children_completed: number;
    max_children_per_session: number;
  };
  status: RunStatus;
}

export type AuditEventType =
  | "dry_run_executed"
  | "mutation_requested"
  | "mutation_approved"
  | "mutation_rejected"
  | "worker_dispatched"
  | "worker_result_received"
  | "step_completed"
  | "checkpoint_written"
  | "run_stopped"
  | "run_completed"
  | "recovery_attempted";

export interface AuditEvent {
  timestamp: string;
  event_type: AuditEventType;
  run_id: string;
  step_cursor: string;
  operator: string;
  operation: string;
  child_id?: string;
  approval_fingerprint?: string;
  result: "ok" | "rejected" | "error" | "preview";
  rejection_reason?: string;
  error_detail?: string;
  metadata?: Record<string, unknown>;
}
