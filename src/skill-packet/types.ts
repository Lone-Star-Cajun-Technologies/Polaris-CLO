export type SkillName = "analyze" | "run" | "ingest" | "promote" | "triage" | "review";

export type AgentRole = "Analyst" | "Foreman" | "Librarian" | "Worker";

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
