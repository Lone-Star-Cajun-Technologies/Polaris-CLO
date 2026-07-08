/**
 * Autoresearch proposal schema and fix zone mapping.
 *
 * AutresearchProposal is the canonical output of the propose command.
 * It maps failed binary gates to Polaris artifact fix zones and records
 * the metadata needed for Linear issue creation.
 *
 * Non-goal: proposals are never auto-applied. They are filed for human review.
 */

import { existsSync, readFileSync } from "node:fs";
import type { DiagnosisReport, QcScoreSummary } from "./score.js";

// ──────────────────────────────────────────────
// ArtifactType union
// ──────────────────────────────────────────────

/**
 * Polaris artifact types that can be targeted by an autoresearch proposal.
 * "doctrine" is intentionally excluded — doctrine changes go through canonical governance.
 */
export type ArtifactType =
  | "skill-prompt"
  | "worker-template"
  | "foreman-template"
  | "analyzer-template"
  | "librarian-template"
  | "medic-template"
  | "workflow-script"
  | "runtime-config"
  | "provider-role-recommendation"
  | "cli-default"
  | "scoring-rule";

// ──────────────────────────────────────────────
// Fix zone mapping entry
// ──────────────────────────────────────────────

export interface FixZoneEntry {
  artifact_type: ArtifactType;
  hint: string;
}

interface RouterFailureFixEntry {
  artifact_type: ArtifactType;
  hint: string;
}

// ──────────────────────────────────────────────
// Fix zone mapping table: gate → artifact type + hint
// ──────────────────────────────────────────────

export const FIX_ZONE_MAP: Record<string, FixZoneEntry> = {
  "user-intervened": {
    artifact_type: "worker-template",
    hint:
      "User pushed commits after polaris-finalize. Tighten worker packet scope and instructions to reduce ambiguity.",
  },
  "foreman-resent-packet": {
    artifact_type: "foreman-template",
    hint:
      "Foreman dispatched the same child more than once. Review dispatch-boundary logic in foreman templates.",
  },
  "foreman-fixed-worker-output": {
    artifact_type: "worker-template",
    hint:
      "Foreman made corrective commits after child-complete. Strengthen allowed_scope and acceptance criteria in the worker template.",
  },
  "worker-output-required-fixing": {
    artifact_type: "worker-template",
    hint:
      "Post-finalize commits indicate insufficient worker output. Add stricter validation commands to the worker template.",
  },
  "validation-failed": {
    artifact_type: "scoring-rule",
    hint:
      "One or more children failed validation. Review validation_commands in the worker packet and the scoring rule thresholds.",
  },
  "worker-went-out-of-scope": {
    artifact_type: "worker-template",
    hint:
      "Worker emitted out-of-scope blocks or returned blocked status. Narrow allowed_scope in the worker template.",
  },
  "foreman-token-burn-over-budget": {
    artifact_type: "foreman-template",
    hint:
      "Foreman bootstrap context exceeds token budget. Reduce packet size in foreman template or raise budget threshold.",
  },
  "state-repair-required": {
    artifact_type: "medic-template",
    hint:
      "Medic artifacts detected — state repair was required. Review medic template heuristics and state-repair triggers.",
  },
  "qc-blocking-findings": {
    artifact_type: "scoring-rule",
    hint:
      "Unresolved critical/high QC findings with attributed confidence. Review QC artifacts, triage open findings, and route repairs before delivery.",
  },
};

const ROUTER_FAILURE_FIX_ZONE_MAP: Record<string, RouterFailureFixEntry> = {
  "quota-exhausted": {
    artifact_type: "runtime-config",
    hint: "Recurring provider quota exhaustion detected. Adjust quota policy and fallback order in execution.routerPolicy, and document expected quota behavior for operators.",
  },
  "capability-mismatch": {
    artifact_type: "provider-role-recommendation",
    hint: "Recurring capability mismatch detected. Update provider capability metadata and role task-type mapping, and document role expectations.",
  },
  "trust-too-low": {
    artifact_type: "provider-role-recommendation",
    hint: "Recurring trust-tier mismatch detected. Update trust policy thresholds or provider trust metadata, and document trust requirements for worker routing.",
  },
  "no-slot": {
    artifact_type: "runtime-config",
    hint: "Recurring slot exhaustion detected. Tune worker pool slot limits and provider slot caps in router policy.",
  },
  "cost-policy": {
    artifact_type: "runtime-config",
    hint: "Recurring cost policy rejection detected. Revisit max cost tier and quota policies in router constraints.",
  },
  "not-in-policy": {
    artifact_type: "provider-role-recommendation",
    hint: "Recurring provider policy mismatch detected. Align rotation/providers with role policy allowlists and update routing docs.",
  },
  "role-disabled": {
    artifact_type: "runtime-config",
    hint: "Worker role is repeatedly disabled by policy. Update providerPolicy.worker and role routing defaults.",
  },
};

// ──────────────────────────────────────────────
// AutresearchProposal type
// ──────────────────────────────────────────────

export interface AutresearchProposal {
  /** Which gate triggered this proposal */
  gate_id: string;
  /** The artifact type to target for the fix */
  artifact_type: ArtifactType;
  /** Human-readable hint for the improvement */
  hint: string;
  /** Run ID this proposal was derived from */
  run_id: string;
  /** Evidence run IDs (includes the triggering run plus any referenced runs) */
  evidence_run_ids: string[];
  /** Confidence score (0.0–1.0) from the diagnosis report */
  confidence: number;
  /** Fix zone label (artifact_type + gate_id) for display */
  fix_zone: string;
}

// ──────────────────────────────────────────────
// Build proposals from a DiagnosisReport
// ──────────────────────────────────────────────

/**
 * Maps a DiagnosisReport's failed gates to AutresearchProposal objects.
 * Gates without a fix zone entry are skipped.
 */
const QC_FIX_ZONE_MAP: Record<string, FixZoneEntry> = {
  "qc-recurring-provider": {
    artifact_type: "provider-role-recommendation",
    hint:
      "A QC provider is producing recurring attributed findings. Review provider capability mapping, role assignment, and confidence thresholds.",
  },
  "qc-recurring-child": {
    artifact_type: "worker-template",
    hint:
      "A child/worker route accumulates recurring QC findings. Tighten packet scope, validation commands, or acceptance criteria for this route.",
  },
  "qc-unvalidated-noise": {
    artifact_type: "runtime-config",
    hint:
      "A large share of QC findings are low/unattributed provider noise. Raise providerConfidenceThreshold or tighten QC provider selection.",
  },
  "qc-recurring-validation": {
    artifact_type: "scoring-rule",
    hint:
      "Unresolved QC findings indicate validation gaps. Strengthen scoring rules and repair routing before delivery.",
  },
  "qc-recurring-docs": {
    artifact_type: "skill-prompt",
    hint:
      "Recurring QC findings relate to documentation. Update skill prompts and worker instructions that produce docs artifacts.",
  },
};

/**
 * Builds QC-derived improvement proposals from the diagnosis report.
 *
 * These recommendations target config, provider, packet-scope, validation,
 * and docs artifacts for recurring QC failure patterns.
 */
export function buildQcProposals(report: DiagnosisReport): AutresearchProposal[] {
  const qc = report.qc_summary;
  if (!qc) return [];

  const proposals: AutresearchProposal[] = [];
  const confidence = Math.max(0, Math.min(1, 1 - qc.qc_penalty));

  const addProposal = (gateId: string, artifactType: ArtifactType, hint: string): void => {
    proposals.push({
      gate_id: gateId,
      artifact_type: artifactType,
      hint,
      run_id: report.run_id,
      evidence_run_ids: [report.run_id],
      confidence,
      fix_zone: `${artifactType}/${gateId}`,
    });
  };

  // Recurring provider signal: multiple blocking findings from the same provider.
  for (const [provider, summary] of Object.entries(qc.provider_breakdown)) {
    if (summary.total >= 2 && summary.blocking > 0) {
      addProposal(
        `qc-recurring-provider:${provider}`,
        "provider-role-recommendation",
        `Provider '${provider}' produced ${summary.blocking} blocking QC findings across ${summary.total} total findings. Review provider capability mapping, role assignment, and confidence thresholds.`,
      );
    }
  }

  // Recurring child/worker route signal: same child owns multiple findings.
  for (const signal of qc.recurring_child_signals) {
    if (signal.finding_count >= 2) {
      addProposal(
        `qc-recurring-child:${signal.child_id}`,
        "worker-template",
        `Child '${signal.child_id}' accumulated ${signal.finding_count} attributed QC findings (weighted score ${signal.weighted_score.toFixed(2)}). Tighten packet scope, validation commands, or acceptance criteria for this worker route.`,
      );
    }
  }

  // High share of unvalidated/provider-noise findings.
  const noiseRatio = qc.total_findings > 0 ? qc.unvalidated_findings / qc.total_findings : 0;
  if (qc.unvalidated_findings >= 3 && noiseRatio > 0.3) {
    addProposal(
      "qc-unvalidated-noise",
      "runtime-config",
      `${qc.unvalidated_findings} of ${qc.total_findings} QC findings are low/unattributed provider noise. Raise providerConfidenceThreshold or tighten QC provider selection in runtime config.`,
    );
  }

  // Unresolved blocking findings indicate a validation/routing gap.
  if (qc.blocking_findings > 0 && qc.weighted_open_score > 0) {
    addProposal(
      "qc-recurring-validation",
      "scoring-rule",
      `${qc.blocking_findings} blocking QC findings remain unresolved (weighted score ${qc.weighted_open_score.toFixed(2)}). Strengthen validation gates and repair routing before delivery.`,
    );
  }

  // Recurring docs-category findings.
  for (const [category, summary] of Object.entries(qc.category_breakdown)) {
    if (category === "docs" && summary.total >= 2) {
      addProposal(
        "qc-recurring-docs",
        "skill-prompt",
        `${summary.total} QC findings relate to documentation. Update skill prompts and worker instructions that produce docs artifacts.`,
      );
    }
  }

  return proposals;
}

export function buildProposals(report: DiagnosisReport): AutresearchProposal[] {
  const proposals: AutresearchProposal[] = [];
  for (const gateId of report.failed_gates) {
    const entry = FIX_ZONE_MAP[gateId];
    if (!entry) continue; // no mapping → skip
    proposals.push({
      gate_id: gateId,
      artifact_type: entry.artifact_type,
      hint: entry.hint,
      run_id: report.run_id,
      evidence_run_ids: [report.run_id],
      confidence: report.score,
      fix_zone: `${entry.artifact_type}/${gateId}`,
    });
  }

  proposals.push(...buildQcProposals(report));

  const recurringRouterFailures = report.router_outcomes?.recurring_failures ?? [];
  for (const failure of recurringRouterFailures) {
    if (failure.occurrences < 2) continue;
    const entry = ROUTER_FAILURE_FIX_ZONE_MAP[failure.reason] ?? {
      artifact_type: "runtime-config" as const,
      hint: "Recurring router failure detected. Review router policy configuration and fallback behavior.",
    };
    proposals.push({
      gate_id: `router-failure:${failure.reason}`,
      artifact_type: entry.artifact_type,
      hint: `${entry.hint} Observed ${failure.occurrences} times across children: ${failure.child_ids.join(", ") || "unknown"}.`,
      run_id: report.run_id,
      evidence_run_ids: [report.run_id],
      confidence: report.score,
      fix_zone: `${entry.artifact_type}/router-failure-${failure.reason}`,
    });
  }
  return proposals;
}

// ──────────────────────────────────────────────
// Diagnosis file loader + schema validator
// ──────────────────────────────────────────────

/**
 * Loads and validates a diagnosis file produced by `polaris autoresearch score`.
 * Throws if the file is missing, unparseable, or does not match DiagnosisReport shape.
 */
export function loadDiagnosisReport(filePath: string): DiagnosisReport {
  if (!existsSync(filePath)) {
    throw new Error(`Diagnosis file not found: ${filePath}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(filePath, "utf-8"));
  } catch (err) {
    throw new Error(`Failed to parse diagnosis file: ${err instanceof Error ? err.message : String(err)}`);
  }
  return validateDiagnosisReport(raw);
}

function defaultRoutingBreakdown(): QcScoreSummary["routing_breakdown"] {
  return { original_worker: 0, repair_worker: 0, follow_up: 0, operator_review: 0, unset: 0 };
}

function normalizeQcScoreSummary(raw: unknown): QcScoreSummary | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const q = raw as Partial<QcScoreSummary>;
  const zeroSeverity = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  const rawOpen =
    q.open_by_severity && typeof q.open_by_severity === "object" && !Array.isArray(q.open_by_severity)
      ? (q.open_by_severity as unknown as Record<string, number>)
      : undefined;
  const openBySeverity = rawOpen ? { ...zeroSeverity, ...rawOpen } : zeroSeverity;

  return {
    total_findings: q.total_findings ?? 0,
    blocking_findings: q.blocking_findings ?? 0,
    autofixed_findings: q.autofixed_findings ?? 0,
    repaired_findings: q.repaired_findings ?? 0,
    waived_findings: q.waived_findings ?? 0,
    unvalidated_findings: q.unvalidated_findings ?? 0,
    open_by_severity: openBySeverity,
    weighted_open_score: q.weighted_open_score ?? 0,
    qc_penalty: q.qc_penalty ?? 0,
    blocks_delivery: q.blocks_delivery ?? false,
    qc_run_count: q.qc_run_count ?? 0,
    provider_breakdown: q.provider_breakdown ?? {},
    routing_breakdown: q.routing_breakdown ?? defaultRoutingBreakdown(),
    category_breakdown: q.category_breakdown ?? {},
    recurring_child_signals: Array.isArray(q.recurring_child_signals) ? q.recurring_child_signals : [],
    recurring_provider_signals: Array.isArray(q.recurring_provider_signals) ? q.recurring_provider_signals : [],
    repair_loop: q.repair_loop ?? null,
    noisy_providers: Array.isArray(q.noisy_providers) ? q.noisy_providers : [],
    has_repair_failures: q.has_repair_failures ?? false,
    unresolved_high_severity: q.unresolved_high_severity ?? 0,
    max_round_exhausted: q.max_round_exhausted ?? false,
  };
}

/**
 * Validates a parsed value against the DiagnosisReport schema.
 * Throws a descriptive error if required fields are missing or have wrong types.
 */
export function validateDiagnosisReport(raw: unknown): DiagnosisReport {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Diagnosis file must be a JSON object.");
  }
  const r = raw as Record<string, unknown>;

  if (typeof r["run_id"] !== "string") throw new Error("Diagnosis report missing required string field: run_id");
  if (typeof r["evaluated_at"] !== "string") throw new Error("Diagnosis report missing required string field: evaluated_at");
  if (!Array.isArray(r["gate_results"])) throw new Error("Diagnosis report missing required array field: gate_results");
  if (!Array.isArray(r["failed_gates"])) throw new Error("Diagnosis report missing required array field: failed_gates");
  if (typeof r["score"] !== "number") throw new Error("Diagnosis report missing required number field: score");
  if (!Array.isArray(r["diagnosis_hints"])) throw new Error("Diagnosis report missing required array field: diagnosis_hints");

  const routerOutcomesRaw = r["router_outcomes"] as Record<string, unknown> | undefined;
  const normalizedRouterOutcomes = routerOutcomesRaw && typeof routerOutcomesRaw === "object"
    ? {
        total_decisions: typeof routerOutcomesRaw["total_decisions"] === "number" ? routerOutcomesRaw["total_decisions"] : 0,
        exhausted_decisions: typeof routerOutcomesRaw["exhausted_decisions"] === "number" ? routerOutcomesRaw["exhausted_decisions"] : 0,
        fallback_attempts: typeof routerOutcomesRaw["fallback_attempts"] === "number" ? routerOutcomesRaw["fallback_attempts"] : 0,
        successful_fallbacks: typeof routerOutcomesRaw["successful_fallbacks"] === "number" ? routerOutcomesRaw["successful_fallbacks"] : 0,
        recurring_failures: Array.isArray(routerOutcomesRaw["recurring_failures"])
          ? routerOutcomesRaw["recurring_failures"]
          : [],
      }
    : {
        total_decisions: 0,
        exhausted_decisions: 0,
        fallback_attempts: 0,
        successful_fallbacks: 0,
        recurring_failures: [],
      };

  const normalizedQcSummary = normalizeQcScoreSummary(r["qc_summary"]);

  return {
    ...(raw as DiagnosisReport),
    router_outcomes: normalizedRouterOutcomes,
    qc_summary: normalizedQcSummary,
  };
}
