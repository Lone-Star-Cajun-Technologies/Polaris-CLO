import { randomUUID } from "node:crypto";
import type { SkillPacketConfig } from "../config/schema.js";
import type { SkillName, AgentRole, SkillPacket, SetupBootstrapMode, SetupBootstrapPacket, SetupBootstrapCheckpoint, CheckpointGate } from "./types.js";

export const SKILL_ROLE_MAP: Record<SkillName, AgentRole> = {
  analyze: "Analyst",
  run: "Foreman",
  ingest: "Librarian",
  promote: "Librarian",
  triage: "Librarian",
  review: "Librarian",
  catalog: "Librarian",
  reconcile: "Librarian",
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
    : "Cross-provider delegation is NOT permitted. Native subagent spawning is prohibited. Use terminal-cli adapter with configured providers (e.g. copilot, codex), or interactive-agent/agent-subtask adapters when running in interactive mode.";

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

/**
 * Builds the ingest skill packet body that defines authority boundaries, prohibited actions, allowed outputs, required deliverables, and stop conditions for processing smartdocs.
 *
 * The packet enforces reading from smartdocs/raw/, classification and routing into smartdocs/, provenance recording, Polaris map updates, doctrine candidate routing, and telemetry emission while forbidding source mutation, silent promotions, writing to root docs/, loop/finalize calls, and conflict suppression.
 *
 * @returns An object with `authority_boundaries`, `prohibited_actions`, `allowed_outputs`, `deliverables`, and `stop_conditions` describing the ingest skill's policies and required outcomes.
 */
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

/**
 * Construct the promotion/governance packet body that governs doctrine/spec promotion and deprecation.
 *
 * @returns The body of a `SkillPacket` for the `promote` skill containing:
 * - `authority_boundaries`: allowed read/verify/promote/deprecate actions and telemetry emission;
 * - `prohibited_actions`: actions that must not be performed (auto-approve, source mutation, suppressing conflicts, etc.);
 * - `allowed_outputs`: permitted resulting artifacts (promoted/ deprecated docs, conflict reports, telemetry);
 * - `deliverables`: required outcomes (reviewed promotions/deprecations and surfaced conflict reports);
 * - `stop_conditions`: conditions that halt the promotion process (all reviewed, unresolved conflicts, missing user approval).
 */
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

function buildTriagePacket(): Omit<SkillPacket, "packet_id" | "skill_name" | "active_role" | "role_summary" | "source_config_snapshot" | "generated_at"> {
  return {
    authority_boundaries: [
      "Read smartdocs/doctrine/active/ to load canonicals for comparison",
      "Read smartdocs/doctrine/candidate/ to load candidates for triage",
      "Call polaris docs triage [--dry-run] [--batch-size N] [--resume] to run the triage pipeline",
      "Read smartdocs/raw/_triage-queue.json and _triage-report.md produced by triage",
      "Emit telemetry events",
    ],
    prohibited_actions: [
      "Move, promote, or delete any document — triage flags only, never decides",
      "Mutate source files (src/, tests, config)",
      "Call polaris loop continue or polaris finalize",
      "Suppress or ignore detected flags",
      "Auto-approve or auto-reject any triage flag without user review",
    ],
    allowed_outputs: [
      "smartdocs/raw/_triage-queue.json — machine-readable flag list for polaris docs review",
      "smartdocs/raw/_triage-report.md — human-readable summary",
      "Telemetry events",
    ],
    deliverables: [
      "_triage-queue.json written with all flags from Phase 1 (doc-vs-doc) and Phase 2 (doc-vs-code)",
      "_triage-report.md written summarising flag counts by type",
      "Checkpoint deleted on successful completion",
    ],
    stop_conditions: [
      "Triage pipeline completes and outputs written",
      "API key not available — report and wait for instruction",
      "Graph coverage below threshold — Phase 2 skipped with warning",
    ],
  };
}

function buildReviewPacket(): Omit<SkillPacket, "packet_id" | "skill_name" | "active_role" | "role_summary" | "source_config_snapshot" | "generated_at"> {
  return {
    authority_boundaries: [
      "Read smartdocs/raw/_triage-queue.json to load pending review decisions",
      "Read candidate documents from smartdocs/doctrine/candidate/ to inform decisions",
      "Evaluate each flagged packet: read the doc, consider the flag type and stale symbols, decide approve/reject/defer",
      "Write decisions back to the triage queue by calling polaris docs review --write-decision <sourcePath> <decision>",
      "Call polaris docs promote <path> for each approved packet (candidate → active)",
      "Call polaris doctrine deprecate <path> for each rejected packet",
      "Emit telemetry events",
    ],
    prohibited_actions: [
      "Move, promote, or delete documents directly — decisions must go through polaris docs ingest",
      "Auto-approve every packet without reading the document content",
      "Mutate source files (src/, tests, config)",
      "Call polaris loop continue or polaris finalize",
      "Suppress or skip flagged packets without recording a decision",
    ],
    allowed_outputs: [
      "Review decisions written to smartdocs/raw/_triage-queue.json",
      "Promoted documents (via polaris docs ingest for approved packets)",
      "Deprecated documents (via polaris docs ingest for rejected packets)",
      "Telemetry events",
    ],
    deliverables: [
      "All pending packets in _triage-queue.json reviewed with approve/reject/defer decision",
      "Approved and rejected packets processed by polaris docs ingest",
      "Summary of decisions reported to user",
    ],
    stop_conditions: [
      "All packets reviewed",
      "Ambiguous packet that requires explicit user input",
      "Ingest error on apply — report and wait for instruction",
    ],
  };
}

const SETUP_BOOTSTRAP_CHECKPOINTS: SetupBootstrapCheckpoint[] = [
  "canon",
  "doc-movement",
  "instruction-files",
  "graph-root",
  "route-scaffold",
  "source-mutation",
];

/**
 * Builds the checkpoint gate that is embedded in every setup-bootstrap packet.
 *
 * Each checkpoint gate entry is a halt instruction — the Foreman MUST stop
 * and surface the gate to the operator before proceeding. Self-approval is
 * structurally impossible: `self_approval_prohibited` is typed as `true` and
 * this function never sets it to anything else.
 */
function buildCheckpointGate(): CheckpointGate {
  const gateInstruction = (name: SetupBootstrapCheckpoint): string =>
    `HALT at checkpoint "${name}": stop, surface this gate to the operator, and wait for explicit approval before proceeding. You may not self-approve.`;

  return {
    gates: {
      canon: gateInstruction("canon"),
      "doc-movement": gateInstruction("doc-movement"),
      "instruction-files": gateInstruction("instruction-files"),
      "graph-root": gateInstruction("graph-root"),
      "route-scaffold": gateInstruction("route-scaffold"),
      "source-mutation": gateInstruction("source-mutation"),
    },
    self_approval_prohibited: true,
    enforcement_note:
      "Checkpoint gates are non-optional. The Foreman must halt and surface each gate to the operator. " +
      "Proceeding without explicit operator approval is a protocol violation.",
  };
}

export function generateSetupBootstrapPacket(mode: SetupBootstrapMode): SetupBootstrapPacket {
  return {
    packet_id: randomUUID(),
    packet_kind: "setup-bootstrap",
    active_role: "Foreman",
    role_file: ".polaris/skills/polaris-run/SKILL.md",
    mode,
    authority_boundaries: [
      "Read repository structure and existing configuration files",
      "Create or update Polaris configuration and scaffold files",
      "Dispatch Workers for bounded setup sub-tasks",
      "Coordinate approval checkpoints before advancing to the next setup phase",
      "Write to .polaris/ directories as part of init or adopt setup",
      "Update POLARIS.md and SUMMARY.md within the project root",
    ],
    prohibited_actions: [
      "Mutate source files without an approved checkpoint (unapproved mutation is forbidden)",
      "Implement features directly — all implementation must be delegated to a Worker",
      "Advance past an approval checkpoint without explicit user confirmation",
      "Self-approve any checkpoint — operator approval is mandatory and cannot be delegated to the Foreman",
      "Modify tracker state or issue descriptions during setup",
    ],
    approval_checkpoints: SETUP_BOOTSTRAP_CHECKPOINTS,
    checkpoint_gate: buildCheckpointGate(),
    stop_conditions: [
      "All setup phases complete and scaffold is valid",
      "An approval checkpoint is reached — pause and await user confirmation",
      "A required configuration value is missing and cannot be inferred",
      "A Worker returns a failure result during setup",
    ],
    generated_at: new Date().toISOString(),
  };
}

function buildCatalogPacket(): Omit<SkillPacket, "packet_id" | "skill_name" | "active_role" | "role_summary" | "source_config_snapshot" | "generated_at"> {
  return {
    authority_boundaries: [
      "Read packet-scoped POLARIS.md and SUMMARY.md files",
      "Update cognition files only within packet-allowed write paths",
      "Read smartdocs/raw/ and classify documents through supported Polaris CLI commands",
      "Auto-place only high-confidence documents",
      "Leave low-confidence documents in raw when unattended or request operator direction",
    ],
    prohibited_actions: [
      "Modify implementation source code, tests, or configuration",
      "Write outside packet-allowed paths",
      "Auto-place low-confidence documents",
      "Move or copy SmartDocs directly instead of using supported CLI commands",
      "Call polaris loop continue or polaris finalize",
      "Git push or create a pull request",
    ],
    allowed_outputs: [
      "Updated POLARIS.md and SUMMARY.md files in packet-allowed paths",
      "Classified documents placed through supported Polaris CLI commands",
      "A sealed local cognition and document commit",
      "A report of deferred low-confidence documents",
    ],
    deliverables: [
      "Packet-scoped cognition reconciled",
      "Raw documents classified or explicitly deferred",
      "All changes recorded in one sealed local commit",
    ],
    stop_conditions: [
      "All packet-scoped cognition and raw documents processed",
      "A required command is unsupported by the installed CLI",
      "A requested write falls outside packet-allowed paths",
      "An unresolved conflict requires operator direction",
    ],
  };
}

function buildReconcilePacket(): Omit<SkillPacket, "packet_id" | "skill_name" | "active_role" | "role_summary" | "source_config_snapshot" | "generated_at"> {
  return {
    authority_boundaries: [
      "Read packet-scoped folders and their POLARIS.md and SUMMARY.md files",
      "Update cognition files only within packet-allowed write paths",
      "Create one sealed local cognition commit",
    ],
    prohibited_actions: [
      "Modify implementation source code, tests, or configuration",
      "Move, ingest, classify, or promote documents",
      "Write outside packet-allowed paths",
      "Call polaris loop continue or polaris finalize",
      "Git push or create a pull request",
    ],
    allowed_outputs: [
      "Updated POLARIS.md and SUMMARY.md files in packet-allowed paths",
      "A sealed local cognition commit",
    ],
    deliverables: [
      "Packet-scoped cognition reconciled with completed work",
      "All cognition changes recorded in one sealed local commit",
    ],
    stop_conditions: [
      "All packet-scoped cognition reconciled",
      "A requested write falls outside packet-allowed paths",
      "Work evidence is missing or contradictory",
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
    case "triage":
      body = buildTriagePacket();
      break;
    case "review":
      body = buildReviewPacket();
      break;
    case "catalog":
      body = buildCatalogPacket();
      break;
    case "reconcile":
      body = buildReconcilePacket();
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

export const SUPPORTED_SKILLS: SkillName[] = [
  "analyze",
  "run",
  "ingest",
  "promote",
  "triage",
  "review",
  "catalog",
  "reconcile",
];
