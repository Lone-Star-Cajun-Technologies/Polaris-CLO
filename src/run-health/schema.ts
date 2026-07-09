import { z } from "zod";

/**
 * Run-health report schema — v1.
 *
 * The run-health report is the canonical artifact for recording symptoms that
 * occur during a Polaris run. It is the single source of truth used by workers,
 * Foreman, closeout, SOL, and Medic.
 *
 * Design rules:
 *   - Report is ONLY created when at least one symptom occurs (YAGNI).
 *   - JSON is the machine-readable source of truth; optional .md sibling for
 *     operator review.
 *   - QC artifacts are referenced by path/id only — QC never writes symptoms.
 *   - All mutations use atomic temp-file + rename to avoid partial writes.
 */

export const SCHEMA_VERSION = "1" as const;

// ──────────────────────────────────────────────
// Sub-schemas
// ──────────────────────────────────────────────

export const SymptomSeverity = z.enum(["critical", "high", "medium", "low"]);
export type SymptomSeverity = z.infer<typeof SymptomSeverity>;

export const SourceActor = z.object({
  /** Polaris role: worker, foreman, medic, etc. */
  role: z.string().min(1),
  /** Child task id when emitted from a worker or child session. */
  child_id: z.string().optional(),
  /** Worker instance id from dispatch record. */
  worker_id: z.string().optional(),
  /** Provider name (e.g. "devin", "claude"). */
  provider: z.string().optional(),
});
export type SourceActor = z.infer<typeof SourceActor>;

export const RunHealthSymptom = z.object({
  /** Unique symptom id within this report (opaque, stable across appends). */
  id: z.string().min(1),
  severity: SymptomSeverity,
  /**
   * Short machine-readable code (e.g. "build-failure", "test-regression").
   * Consumers use this for routing; keep it stable between runs.
   */
  code: z.string().min(1),
  /** Human-readable description for operator review. */
  message: z.string().min(1),
  /** Actor that observed and recorded this symptom. */
  source_actor: SourceActor,
  /**
   * Paths or ids of QC/evidence artifacts this symptom is based on.
   * QC artifacts live at .polaris/clusters/<cluster-id>/qc/<qcRunId>.json.
   * Symptom producers reference them by path; QC itself never writes here.
   */
  evidence_refs: z.array(z.string()).default([]),
  occurred_at: z.string().datetime(),
});
export type RunHealthSymptom = z.infer<typeof RunHealthSymptom>;

export const PolicyBypassMetadata = z.object({
  reason: z.string().min(1),
  /** Actor that approved the bypass. */
  bypassed_by: z.string().min(1),
  bypassed_at: z.string().datetime(),
});
export type PolicyBypassMetadata = z.infer<typeof PolicyBypassMetadata>;

export const MedicConsultStatus = z.enum([
  "pending",
  "in-progress",
  "resolved",
  "bypassed",
]);
export type MedicConsultStatus = z.infer<typeof MedicConsultStatus>;

export const MedicConsult = z.object({
  status: MedicConsultStatus,
  /**
   * References to Medic chart files (CHART-YYYY-MM-DD-NNN format).
   * Charts live under .polaris/charts/. Referenced by id/path, never embedded.
   */
  chart_refs: z.array(z.string()).default([]),
  /**
   * References to Medic treatment packet files.
   * Treatment packets live under .polaris/clusters/<id>/medic/.
   * Referenced by path, never embedded.
   */
  treatment_packet_refs: z.array(z.string()).default([]),
  resolved_at: z.string().datetime().optional(),
  resolution_notes: z.string().optional(),
});
export type MedicConsult = z.infer<typeof MedicConsult>;

// ──────────────────────────────────────────────
// Root schema
// ──────────────────────────────────────────────

export const RunHealthReport = z.object({
  schema_version: z.literal(SCHEMA_VERSION),
  run_id: z.string().min(1),
  cluster_id: z.string().min(1),
  /** Ordered list of symptoms; newest appended at end. */
  symptoms: z.array(RunHealthSymptom),
  /**
   * Run-level evidence refs (e.g. telemetry path, state snapshot).
   * Individual symptoms carry their own evidence_refs; this field holds
   * refs that apply to the report as a whole.
   */
  evidence_refs: z.array(z.string()).default([]),
  /**
   * Present only when an operator or SOL has explicitly bypassed policy
   * gates based on this report. Absence means no bypass has been granted.
   */
  policy_bypass: PolicyBypassMetadata.optional(),
  /**
   * Present only when Medic has been consulted. Absence means no Medic
   * consult has occurred — closeout must not infer severity from absence.
   */
  medic_consult: MedicConsult.optional(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  /** Actor that created the report (first producer). */
  source_actor: SourceActor,
});

export type RunHealthReport = z.infer<typeof RunHealthReport>;

// ──────────────────────────────────────────────
// Validation helpers
// ──────────────────────────────────────────────

export interface RunHealthValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateRunHealthReport(
  data: unknown,
): RunHealthValidationResult {
  const result = RunHealthReport.safeParse(data);
  if (!result.success) {
    return {
      valid: false,
      errors: result.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`),
    };
  }
  return { valid: true, errors: [] };
}
