import { randomUUID } from "node:crypto";
import type { SkillPacketConfig } from "../config/schema.js";
import type { SkillName, AgentRole, SkillPacket } from "./types.js";

export const SKILL_ROLE_MAP: Record<SkillName, AgentRole> = {
  analyze: "Analyst",
  run: "Foreman",
  ingest: "Librarian",
  promote: "Librarian",
};

const ROLE_SUMMARIES: Record<AgentRole, string> = {
  Analyst:
    "The Analyst gathers evidence, assesses feasibility, and produces implementation-ready plans. The Analyst shapes work but never executes it.",
  Foreman:
    "The Foreman coordinates implementation by dispatching Workers. The Foreman never writes code directly — all implementation is delegated.",
  Librarian:
    "The Librarian ingests, classifies, indexes, and promotes knowledge artifacts. The Librarian preserves provenance and maintains canonical structure.",
  Worker:
    "The Worker implements a focused, bounded task as directed by the Foreman. The Worker owns implementation for its assigned child.",
};

function buildAnalyzePacket(config: Required<SkillPacketConfig>): Omit<SkillPacket, "packet_id" | "skill_name" | "active_role" | "role_summary" | "source_config_snapshot" | "generated_at"> {
  const onBelowThreshold = config.auto_deep_analysis ? "auto_proceed" : "ask_user";
  return {
    authority_boundaries: [
      "Inspect repository files and architecture",
      "Query repo-analysis providers for code intelligence",
      "Summarize findings and assess feasibility",
      "Create implementation plans and specs in docs/",
      "Create or update tracker child issues",
      "Generate local cluster artifacts (.polaris/clusters/)",
      "Update tracker comments and status",
      "Close the analysis issue when complete",
    ],
    prohibited_actions: [
      "Implement production or runtime code",
      "Mutate source files (src/, tests, config)",
      "Execute implementation loops",
      "Open implementation PRs",
      "Continue automatically into polaris-run execution",
      "Call polaris loop continue or polaris finalize",
    ],
    allowed_outputs: [
      "Linear issue descriptions and child issues",
      "Cluster artifact files (.polaris/clusters/)",
      "Spec documents in docs/",
      "Tracker comments and status updates",
    ],
    deliverables: [
      "Implementation-ready Linear issues, or",
      "Explanation of why user approval is needed for deeper analysis",
    ],
    stop_conditions: [
      "All cluster children created and linked",
      "Confidence below threshold and user approval required but not yet obtained",
      "Blocking dependency discovered that prevents planning",
    ],
    confidence_policy: {
      threshold: config.analysis_confidence_threshold,
      auto_deep_analysis: config.auto_deep_analysis,
      on_below_threshold: onBelowThreshold,
    },
  };
}

function buildRunPacket(config: Required<SkillPacketConfig>): Omit<SkillPacket, "packet_id" | "skill_name" | "active_role" | "role_summary" | "source_config_snapshot" | "generated_at"> {
  const delegationNote = config.allow_cross_provider_delegation
    ? "Cross-provider delegation is permitted per configuration."
    : "Cross-provider delegation is NOT permitted. Use internal child/subagent fallback only.";

  return {
    authority_boundaries: [
      "Read cluster artifacts and current run state",
      "Call polaris loop dispatch to assign work to a Worker",
      "Call polaris loop continue after a Worker has returned results",
      "Call polaris loop status to check run state",
      "Pass worker packets to the internal child/subagent as the full prompt",
      `Delegation policy: ${delegationNote}`,
    ],
    prohibited_actions: [
      "Implement code directly (inline implementation is forbidden)",
      "Modify source files without dispatching a Worker",
      "Mark a child complete without Worker result evidence",
      "Attempt cross-provider delegation unless explicitly configured",
      "Call polaris finalize before all children are complete",
    ],
    allowed_outputs: [
      "polaris loop dispatch invocations",
      "polaris loop continue invocations (post-worker only)",
      "polaris loop status output",
      "Worker packet contents passed to internal child/subagent",
    ],
    deliverables: [
      "All assigned children dispatched and completed via Worker",
      "Run checkpointed after each child",
    ],
    stop_conditions: [
      "All cluster children complete",
      "A child returns status failed and stop_on_fail is enabled",
      "Budget cap reached",
      "Worker result evidence is absent — do not mark complete without it",
    ],
  };
}

function buildIngestPacket(): Omit<SkillPacket, "packet_id" | "skill_name" | "active_role" | "role_summary" | "source_config_snapshot" | "generated_at"> {
  return {
    authority_boundaries: [
      "Read documents from smartdocs/raw/",
      "Classify documents by content analysis and front-matter",
      "Route documents to correct authority directories within smartdocs/",
      "Write provenance records alongside placed files",
      "Update Polaris map entries to link docs to code areas",
      "Propose doctrine candidates (route to doctrine/candidate/ only)",
      "Emit telemetry events",
    ],
    prohibited_actions: [
      "Write new Smart Docs to root docs/ — smartdocs/ is the canonical target",
      "Silently promote documents to doctrine/active/, specs/active/, architecture/, or decisions/",
      "Mutate source files (src/, tests, config)",
      "Call polaris loop continue or polaris finalize",
      "Suppress detected conflicts",
    ],
    allowed_outputs: [
      "Classified and routed documents in smartdocs/",
      "Provenance sidecar records",
      "Polaris map entry updates",
      "Doctrine candidate proposals in doctrine/candidate/",
      "Telemetry events",
    ],
    deliverables: [
      "All pending raw documents classified and routed",
      "Provenance records written",
      "Map entries updated",
    ],
    stop_conditions: [
      "All documents in raw/ processed",
      "Conflict detected that requires user resolution",
      "Document cannot be classified — report and wait for instruction",
    ],
  };
}

function buildPromotePacket(): Omit<SkillPacket, "packet_id" | "skill_name" | "active_role" | "role_summary" | "source_config_snapshot" | "generated_at"> {
  return {
    authority_boundaries: [
      "Read smartdocs/raw/ and smartdocs/doctrine/candidate/ to identify promotion candidates",
      "Read linked source files (from linkedMapArea in provenance sidecar) to verify relevance",
      "Read smartdocs/doctrine/active/ and smartdocs/specs/active/ to check for conflicts",
      "Call polaris doctrine spec-promote <path> to surface the conflict report (without --approve)",
      "Call polaris doctrine spec-promote <path> --approve only after surfacing report and receiving explicit user confirmation",
      "Call polaris doctrine promote <path> for doctrine candidates that pass governance checks",
      "Call polaris doctrine deprecate <path> for active docs that are superseded or stale",
      "Emit telemetry events",
    ],
    prohibited_actions: [
      "Auto-promote without surfacing the conflict report first",
      "Call --approve without explicit user confirmation in the session",
      "Mutate source files (src/, tests, config)",
      "Call polaris loop continue or polaris finalize",
      "Promote to architecture/ or decisions/ — those require explicit ADR process",
      "Suppress or ignore detected conflicts",
    ],
    allowed_outputs: [
      "Promoted documents in doctrine/active/ or specs/active/",
      "Deprecated documents with deprecation markers",
      "Conflict reports surfaced to user",
      "Telemetry events",
    ],
    deliverables: [
      "Reviewed candidates promoted, deprecated, or deferred with explanation",
      "All conflict reports surfaced before any promotion",
    ],
    stop_conditions: [
      "All candidates reviewed",
      "Unresolved conflict requiring user decision",
      "User confirmation not obtained before --approve step",
    ],
  };
}

export function generateSkillPacket(
  skillName: SkillName,
  config: Required<SkillPacketConfig>,
): SkillPacket {
  const active_role = SKILL_ROLE_MAP[skillName];
  const role_summary = ROLE_SUMMARIES[active_role];
  const generated_at = new Date().toISOString();
  const packet_id = randomUUID();

  const source_config_snapshot = {
    analysis_confidence_threshold: config.analysis_confidence_threshold,
    auto_deep_analysis: config.auto_deep_analysis,
    allow_cross_provider_delegation: config.allow_cross_provider_delegation,
  };

  let body: Omit<SkillPacket, "packet_id" | "skill_name" | "active_role" | "role_summary" | "source_config_snapshot" | "generated_at">;

  switch (skillName) {
    case "analyze":
      body = buildAnalyzePacket(config);
      break;
    case "run":
      body = buildRunPacket(config);
      break;
    case "ingest":
      body = buildIngestPacket();
      break;
    case "promote":
      body = buildPromotePacket();
      break;
  }

  return {
    packet_id,
    skill_name: skillName,
    active_role,
    role_summary,
    ...body,
    source_config_snapshot,
    generated_at,
  };
}

export const SUPPORTED_SKILLS: SkillName[] = ["analyze", "run", "ingest", "promote"];
