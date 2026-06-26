export type SkillName =
  | "analyze"
  | "run"
  | "ingest"
  | "promote"
  | "triage"
  | "review"
  | "catalog"
  | "reconcile";

export type AgentRole = "Analyst" | "Foreman" | "Librarian" | "Worker";

export type SetupBootstrapMode = "init" | "adopt";

export type SetupBootstrapCheckpoint =
  | "canon"
  | "doc-movement"
  | "instruction-files"
  | "graph-root"
  | "route-scaffold"
  | "source-mutation";

/**
 * Enforcement record embedded in every setup-bootstrap packet.
 * Presence of this field (with self_approval_prohibited: true) is the
 * "by construction" guarantee that the Foreman cannot self-approve.
 */
export interface CheckpointGate {
  /** Each checkpoint name maps to the halt instruction the Foreman must follow. */
  gates: Record<SetupBootstrapCheckpoint, string>;
  /** Always true — the packet cannot be generated without this flag set. */
  self_approval_prohibited: true;
  /** Human-readable enforcement summary surfaced to the Foreman. */
  enforcement_note: string;
}

export interface SetupBootstrapPacket {
  packet_id: string;
  packet_kind: "setup-bootstrap";
  active_role: "Foreman";
  role_file: string;
  mode: SetupBootstrapMode;
  authority_boundaries: string[];
  prohibited_actions: string[];
  approval_checkpoints: SetupBootstrapCheckpoint[];
  /** Checkpoint enforcement block. Always present; self_approval_prohibited is always true. */
  checkpoint_gate: CheckpointGate;
  stop_conditions: string[];
  generated_at: string;
}

export interface ConfidencePolicy {
  threshold: number;
  auto_deep_analysis: boolean;
  on_below_threshold: "ask_user" | "auto_proceed";
}

export interface SkillPacket {
  packet_id: string;
  skill_name: SkillName;
  active_role: AgentRole;
  role_summary: string;
  authority_boundaries: string[];
  prohibited_actions: string[];
  allowed_outputs: string[];
  deliverables: string[];
  stop_conditions: string[];
  confidence_policy?: ConfidencePolicy;
  source_config_snapshot: {
    analysis_confidence_threshold: number;
    auto_deep_analysis: boolean;
    allow_cross_provider_delegation: boolean;
  };
  generated_at: string;
}
