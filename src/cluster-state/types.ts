export type ChildLifecycleStatus =
  | 'ready'
  | 'claimed'
  | 'dispatched'
  | 'running'
  | 'done'
  | 'failed'
  | 'blocked'
  | 'reviewed'
  | 'finalized';

export interface ChildState {
  id: string;
  status: ChildLifecycleStatus;
  commit?: string;
}

export interface ClaimMetadata {
  worker_id: string;
  claimed_at: string; // ISO 8601
  expires_at: string; // ISO 8601
}

export interface PacketPointer {
  [childId: string]: string;
}

export interface ResultPointer {
  [childId: string]: string;
}

export interface ValidationResult {
  passed: boolean;
  output: string;
}

export interface Blocker {
  blocker_id: string;
  reason: string;
  created_at: string; // ISO 8601
  resolved_at?: string; // ISO 8601
}

export type TrackerMutationStatus =
  | 'pending'
  | 'sent'
  | 'succeeded'
  | 'failed'
  | 'conflicted'
  | 'blocked';

export interface TrackerMutationReference {
  mutation_ids: string[];
  idempotency_key: string;
  source_state_generation: number;
  result_file: string;
  packet_file?: string;
  commit?: string;
  status: TrackerMutationStatus;
  updated_at: string;
  last_attempted_at?: string;
  last_error?: string;
}

export type QcRunStatus =
  | "passed"
  | "findings"
  | "blocked"
  | "failed"
  | "skipped";

export interface QcRunPointer {
  /** Absolute or repo-relative path to the QC result artifact. */
  artifact_path: string;
  /** Normalized status of the QC run. */
  status: QcRunStatus;
  /** QC provider name. */
  provider: string;
  /** ISO 8601 start timestamp. */
  started_at: string;
  /** ISO 8601 completion timestamp. */
  completed_at: string;
}

export interface ClusterState {
  schema_version: string;
  cluster_id: string;
  state_generation: number;
  child_states: ChildState[];
  claim_metadata: { [childId: string]: ClaimMetadata };
  packet_pointers: PacketPointer;
  result_pointers: ResultPointer;
  validation_results: { [key: string]: ValidationResult };
  commits: { [childId: string]: string };
  tracker_mutations: { [childId: string]: TrackerMutationReference };
  blockers: Blocker[];
  /** QC result artifact pointers keyed by qcRunId. */
  qc_runs?: { [qcRunId: string]: QcRunPointer };
  /** Base branch against which this run will deliver a PR (e.g. "main"). */
  base_branch?: string;
  /** SHA of base_branch tip at the moment delivery branch custody was established. */
  base_sha?: string;
  /** Delivery branch that all workers for this cluster must run on. */
  delivery_branch?: string;
}
