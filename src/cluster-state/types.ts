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
  blockers: Blocker[];
}
