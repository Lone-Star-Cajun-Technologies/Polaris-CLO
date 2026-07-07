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
import type { DiagnosisReport } from "./score.js";

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

  return {
    ...(raw as DiagnosisReport),
    router_outcomes: normalizedRouterOutcomes,
  };
}
