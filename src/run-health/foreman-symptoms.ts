/**
 * Foreman-side runtime symptom emission.
 *
 * The Foreman appends symptoms ONLY for Polaris-runtime intervention events
 * (state repair, cluster repair, missing packet/result repair, dispatch
 * boundary repair, QC/finalize runtime failure, local/global binary mismatch,
 * and manual intervention).
 *
 * Symptoms are NOT emitted for non-Polaris target repositories unless
 * `run_health.foreman_symptoms.enabled` is explicitly set to true in
 * polaris.config.json.
 *
 * QC providers remain unchanged artifact producers — they never write here.
 */

import { randomUUID } from "node:crypto";
import type { PolarisConfig } from "../config/schema.js";
import {
  createRunHealthReport,
  appendSymptom,
  readRunHealthReport,
} from "./index.js";
import type { RunHealthSymptom, SourceActor } from "./schema.js";

// ── Symptom codes ─────────────────────────────────────────────────────────────

/**
 * Machine-readable Foreman symptom codes.
 * Kept stable across runs so Medic/SOL can correlate by code.
 */
export type ForemanSymptomCode =
  /** Foreman repaired Polaris-repo state (current-state.json reload fallback). */
  | "foreman-state-repair"
  /** Foreman repaired cluster state (cluster store sync failure or recovery). */
  | "foreman-cluster-repair"
  /** Foreman repaired a missing packet or result artifact. */
  | "foreman-packet-repair"
  /** Foreman repaired a dispatch boundary violation (illegal-state-transition). */
  | "foreman-dispatch-boundary-repair"
  /** Foreman attempted finalize recovery after a failure. */
  | "foreman-finalize-recovery"
  /** QC or finalize step threw a runtime error. */
  | "foreman-qc-runtime-failure"
  /** Medic run-health consult threw a runtime error. */
  | "foreman-medic-runtime-failure"
  /** Local Polaris binary does not match the global binary. */
  | "foreman-binary-mismatch"
  /** Operator manually intervened in the run. */
  | "foreman-manual-intervention"
  /** Worker returned a result for a different child (wrong-run telemetry). */
  | "foreman-wrong-run-telemetry";

// ── Policy ────────────────────────────────────────────────────────────────────

/**
 * Returns true when Foreman-side symptom emission is enabled.
 *
 * Emission is enabled when `run_health.foreman_symptoms.enabled === true` in
 * the project's polaris.config.json. Foreman symptoms are disabled by default
 * so that non-Polaris target repositories are not automatically marked sick.
 */
export function isForemanSymptomEnabled(
  config: Pick<PolarisConfig, "run_health"> | null | undefined,
): boolean {
  return config?.run_health?.foreman_symptoms?.enabled === true;
}

// ── Symptom emission ──────────────────────────────────────────────────────────

export interface AppendForemanSymptomParams {
  runId: string;
  clusterId: string;
  code: ForemanSymptomCode;
  message: string;
  /** Optional evidence artifact refs (paths to QC runs, telemetry, etc.). */
  evidenceRefs?: string[];
  repoRoot?: string;
  /**
   * Optional config for policy gating. When provided, the function checks
   * `isForemanSymptomEnabled(config)` and no-ops when disabled.
   * When omitted, the caller is responsible for policy gating.
   */
  config?: Pick<PolarisConfig, "run_health"> | null;
}

/**
 * Append a Foreman-side runtime symptom to the run-health report.
 *
 * Creates the report when one does not yet exist; appends to it when one does.
 * When `config` is provided, checks `isForemanSymptomEnabled(config)` and
 * no-ops when disabled (so the caller does not need to guard).
 * Never throws — symptom emission is advisory and must not block the run.
 */
export function appendForemanSymptom(params: AppendForemanSymptomParams): void {
  const { runId, clusterId, code, message, evidenceRefs, repoRoot, config } = params;

  // Policy gate: skip when config is provided but policy is not enabled.
  if (config !== undefined && !isForemanSymptomEnabled(config)) {
    return;
  }

  const sourceActor: SourceActor = {
    role: "foreman",
  };

  const symptom: RunHealthSymptom = {
    id: `foreman:${code}:${randomUUID()}`,
    severity: foremanCodeSeverity(code),
    code,
    message,
    source_actor: sourceActor,
    evidence_refs: evidenceRefs ?? [],
    occurred_at: new Date().toISOString(),
  };

  try {
    const existing = readRunHealthReport(runId, repoRoot);
    if (!existing) {
      createRunHealthReport({
        runId,
        clusterId,
        firstSymptom: symptom,
        sourceActor,
        repoRoot,
      });
    } else {
      appendSymptom(runId, symptom, repoRoot);
    }
  } catch {
    // Symptom emission must never block the run — swallow errors silently.
    // ponytail: surface to telemetry in a future pass
  }
}

/**
 * Maps a Foreman symptom code to its default severity.
 */
function foremanCodeSeverity(code: ForemanSymptomCode): RunHealthSymptom["severity"] {
  switch (code) {
    case "foreman-dispatch-boundary-repair":
      return "critical";
    case "foreman-state-repair":
    case "foreman-cluster-repair":
    case "foreman-packet-repair":
    case "foreman-qc-runtime-failure":
    case "foreman-medic-runtime-failure":
    case "foreman-binary-mismatch":
    case "foreman-wrong-run-telemetry":
      return "high";
    case "foreman-finalize-recovery":
      return "medium";
    case "foreman-manual-intervention":
      return "low";
    default:
      return "medium";
  }
}
