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

/** Per-child summary that may be included in a reconcile/catalog work inventory. */
export interface ReconcileChildSummary {
  child_id: string;
  title: string;
  commit_sha: string | null;
  changed_files: string[];
  /** Repo-relative path to the child's compact result JSON, if available. */
  compact_return_path: string | null;
  /** Repo-relative path to a pending cognition note for the child, if available. */
  cognition_note_path: string | null;
}

/** Work inventory carried by a ReconcilePacket (or CatalogPacket). */
export interface ReconcileWorkInventory {
  /** Folders whose POLARIS.md and/or SUMMARY.md may need updating. */
  affected_folders: string[];
  /** All files changed by the completed work (repo-relative). */
  all_changed_files: string[];
  /** Per-child summaries when the packet is cluster-based; empty for standalone reconciles. */
  child_summaries: ReconcileChildSummary[];
  /** Repo-relative paths to pending cognition notes. */
  pending_cognition_notes: string[];
  /** Current POLARIS.md content keyed by folder path. */
  polaris_md_files: Record<string, string | null>;
  /** Current SUMMARY.md content keyed by folder path. */
  summary_md_files: Record<string, string | null>;
}

/** Reconciliation constraints. */
export interface ReconcileConstraints {
  /** Maximum net new lines per SUMMARY.md update. */
  max_summary_addition_lines: number;
}

/**
 * Packet returned by `polaris skill packet reconcile`.
 *
 * Reconcile packets are scoped to the current working branch/diff, not a full cluster
 * closeout, and provide the runtime-authoritative `affected_folders` and `work_inventory`
 * the `polaris-reconcile` and `polaris-catalog` skills require.
 */
export interface ReconcilePacket extends SkillPacket {
  packet_kind: "reconcile";
  /** Identifier for this reconcile run. */
  run_id: string;
  /** Bound issue or cluster identifier (e.g. `POL-257`). */
  issue_id: string;
  /** Folders whose POLARIS.md and/or SUMMARY.md may need updating. */
  affected_folders: string[];
  /** Summary of completed work: changed files, child summaries, cognition notes. */
  work_inventory: ReconcileWorkInventory;
  /** Paths this skill may write. */
  allowed_write_paths: string[];
  /** Paths this skill must not write. */
  prohibited_write_paths: string[];
  /** Reconciliation constraints. */
  constraints: ReconcileConstraints;
}
