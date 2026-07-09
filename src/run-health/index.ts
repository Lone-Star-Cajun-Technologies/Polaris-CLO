import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  SCHEMA_VERSION,
  type MedicConsult,
  type MedicConsultStatus,
  type PolicyBypassMetadata,
  type RunHealthReport,
  type RunHealthSymptom,
  type SourceActor,
  validateRunHealthReport,
} from "./schema.js";

// ──────────────────────────────────────────────
// Path resolution
// ──────────────────────────────────────────────

/**
 * Returns the directory that contains the run-health report for a given run.
 * Active reports live under .polaris/runs/<run-id>/
 */
export function getRunHealthDir(runId: string, repoRoot?: string): string {
  return join(repoRoot ?? process.cwd(), ".polaris", "runs", runId);
}

/**
 * Returns the absolute path to the run-health JSON report.
 * The file is created on demand; its absence means no symptoms occurred.
 */
export function getRunHealthReportPath(runId: string, repoRoot?: string): string {
  return join(getRunHealthDir(runId, repoRoot), "run-health-report.json");
}

/**
 * Returns the optional Markdown sibling path for operator review.
 * The .md file is never required for machine consumption.
 */
export function getRunHealthMarkdownPath(runId: string, repoRoot?: string): string {
  return join(getRunHealthDir(runId, repoRoot), "run-health-report.md");
}

// ──────────────────────────────────────────────
// Atomic write helper
// ──────────────────────────────────────────────

function writeJsonAtomic(filePath: string, data: unknown): void {
  const tempPath = `${filePath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  try {
    writeFileSync(tempPath, JSON.stringify(data, null, 2), "utf-8");
    renameSync(tempPath, filePath);
  } catch (err) {
    try {
      unlinkSync(tempPath);
    } catch {
      // Ignore cleanup failure.
    }
    throw err;
  }
}

// ──────────────────────────────────────────────
// Read
// ──────────────────────────────────────────────

/**
 * Read the run-health report for a given run.
 * Returns null when no symptoms have been recorded (file absent or unreadable).
 * Throws if the file exists but fails schema validation — this indicates
 * a corrupt artifact that must not be silently ignored.
 */
export function readRunHealthReport(
  runId: string,
  repoRoot?: string,
): RunHealthReport | null {
  const filePath = getRunHealthReportPath(runId, repoRoot);
  if (!existsSync(filePath)) return null;

  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }

  const parsed: unknown = JSON.parse(raw);
  const validation = validateRunHealthReport(parsed);
  if (!validation.valid) {
    throw new Error(
      `run-health report for run "${runId}" failed schema validation:\n` +
        validation.errors.join("\n"),
    );
  }
  return parsed as RunHealthReport;
}

// ──────────────────────────────────────────────
// Create
// ──────────────────────────────────────────────

export interface CreateRunHealthReportParams {
  runId: string;
  clusterId: string;
  firstSymptom: RunHealthSymptom;
  /** Evidence refs that apply to the report as a whole. */
  evidenceRefs?: string[];
  sourceActor: SourceActor;
  repoRoot?: string;
}

/**
 * Create a new run-health report with the first symptom.
 * Throws if a report already exists for this run — use appendSymptom instead.
 * Returns the created report (immutable copy).
 */
export function createRunHealthReport(
  params: CreateRunHealthReportParams,
): RunHealthReport {
  const { runId, clusterId, firstSymptom, evidenceRefs, sourceActor, repoRoot } = params;
  const filePath = getRunHealthReportPath(runId, repoRoot);

  if (existsSync(filePath)) {
    throw new Error(
      `run-health report already exists for run "${runId}" — use appendSymptom to add symptoms`,
    );
  }

  const now = new Date().toISOString();
  const report: RunHealthReport = {
    schema_version: SCHEMA_VERSION,
    run_id: runId,
    cluster_id: clusterId,
    symptoms: [firstSymptom],
    evidence_refs: evidenceRefs ?? [],
    created_at: now,
    updated_at: now,
    source_actor: sourceActor,
  };

  const validation = validateRunHealthReport(report);
  if (!validation.valid) {
    throw new Error(
      `Invalid run-health report:\n${validation.errors.join("\n")}`,
    );
  }

  mkdirSync(getRunHealthDir(runId, repoRoot), { recursive: true });
  writeJsonAtomic(filePath, report);
  return Object.freeze({ ...report }) as RunHealthReport;
}

// ──────────────────────────────────────────────
// Append
// ──────────────────────────────────────────────

/**
 * Append a symptom to an existing run-health report.
 * Creates the report if it does not exist (convenience overload — callers
 * may use createRunHealthReport for explicit first-write semantics).
 * Returns the updated report (immutable copy).
 */
export function appendSymptom(
  runId: string,
  symptom: RunHealthSymptom,
  repoRoot?: string,
): RunHealthReport {
  const filePath = getRunHealthReportPath(runId, repoRoot);

  const existing = readRunHealthReport(runId, repoRoot);
  if (!existing) {
    throw new Error(
      `No run-health report found for run "${runId}" — use createRunHealthReport first`,
    );
  }

  const updated: RunHealthReport = {
    ...existing,
    symptoms: [...existing.symptoms, symptom],
    updated_at: new Date().toISOString(),
  };

  const validation = validateRunHealthReport(updated);
  if (!validation.valid) {
    throw new Error(
      `Appended symptom produces invalid report:\n${validation.errors.join("\n")}`,
    );
  }

  writeJsonAtomic(filePath, updated);
  return Object.freeze({ ...updated }) as RunHealthReport;
}

// ──────────────────────────────────────────────
// Mark bypassed
// ──────────────────────────────────────────────

/**
 * Record that policy gates based on this report have been explicitly bypassed.
 * Idempotent: re-calling with the same reason overwrites the bypass metadata.
 * Returns the updated report (immutable copy).
 */
export function markBypassed(
  runId: string,
  bypass: PolicyBypassMetadata,
  repoRoot?: string,
): RunHealthReport {
  const filePath = getRunHealthReportPath(runId, repoRoot);
  const existing = readRunHealthReport(runId, repoRoot);
  if (!existing) {
    throw new Error(`No run-health report found for run "${runId}"`);
  }

  const updated: RunHealthReport = {
    ...existing,
    policy_bypass: bypass,
    updated_at: new Date().toISOString(),
  };

  const validation = validateRunHealthReport(updated);
  if (!validation.valid) {
    throw new Error(
      `Policy bypass produces invalid report:\n${validation.errors.join("\n")}`,
    );
  }

  writeJsonAtomic(filePath, updated);
  return Object.freeze({ ...updated }) as RunHealthReport;
}

// ──────────────────────────────────────────────
// Mark Medic decision
// ──────────────────────────────────────────────

export interface MedicDecisionParams {
  status: MedicConsultStatus;
  chartRefs?: string[];
  treatmentPacketRefs?: string[];
  resolvedAt?: string;
  resolutionNotes?: string;
}

/**
 * Record the Medic consult status and associated artifact references.
 * Merges with any existing consult metadata (chart/treatment refs are additive).
 * Returns the updated report (immutable copy).
 */
export function markMedicDecision(
  runId: string,
  decision: MedicDecisionParams,
  repoRoot?: string,
): RunHealthReport {
  const filePath = getRunHealthReportPath(runId, repoRoot);
  const existing = readRunHealthReport(runId, repoRoot);
  if (!existing) {
    throw new Error(`No run-health report found for run "${runId}"`);
  }

  const prevConsult = existing.medic_consult;
  const mergedConsult: MedicConsult = {
    status: decision.status,
    chart_refs: [
      ...(prevConsult?.chart_refs ?? []),
      ...(decision.chartRefs ?? []),
    ],
    treatment_packet_refs: [
      ...(prevConsult?.treatment_packet_refs ?? []),
      ...(decision.treatmentPacketRefs ?? []),
    ],
    resolved_at: decision.resolvedAt ?? prevConsult?.resolved_at,
    resolution_notes: decision.resolutionNotes ?? prevConsult?.resolution_notes,
  };

  const updated: RunHealthReport = {
    ...existing,
    medic_consult: mergedConsult,
    updated_at: new Date().toISOString(),
  };

  const validation = validateRunHealthReport(updated);
  if (!validation.valid) {
    throw new Error(
      `Medic decision produces invalid report:\n${validation.errors.join("\n")}`,
    );
  }

  writeJsonAtomic(filePath, updated);
  return Object.freeze({ ...updated }) as RunHealthReport;
}

// ──────────────────────────────────────────────
// Upsert — create or append worker symptoms
// ──────────────────────────────────────────────

import type { WorkerRunHealthSymptom } from "../types/result-packet.js";

export interface UpsertWorkerSymptomsParams {
  runId: string;
  clusterId: string;
  childId: string;
  workerId?: string;
  provider?: string;
  symptoms: WorkerRunHealthSymptom[];
  repoRoot?: string;
}

/**
 * Ingest worker-reported symptoms into the run-health report.
 *
 * Creates the report when one does not yet exist; appends to it when one does.
 * No-ops when `symptoms` is empty — no report is created or modified.
 * Returns the updated report, or null when no symptoms were provided.
 */
export function upsertWorkerSymptoms(
  params: UpsertWorkerSymptomsParams,
): RunHealthReport | null {
  const { runId, clusterId, childId, workerId, provider, symptoms, repoRoot } = params;
  if (!symptoms || symptoms.length === 0) return null;

  const sourceActor: SourceActor = {
    role: "worker",
    child_id: childId,
    worker_id: workerId,
    provider,
  };

  const existing = readRunHealthReport(runId, repoRoot);
  const offset = existing?.symptoms.length ?? 0;

  const toRunHealthSymptom = (s: WorkerRunHealthSymptom, index: number): RunHealthSymptom => ({
    // Stable id: child + category + (offset + index) so repeated calls don't collide
    id: `${childId}:${s.category}:${offset + index}`,
    severity: mapCategoryToSeverity(s.category),
    code: s.category,
    message: s.message,
    source_actor: sourceActor,
    evidence_refs: s.evidence_refs ?? [],
    occurred_at: s.occurred_at,
  });

  if (!existing) {
    const [first, ...rest] = symptoms.map(toRunHealthSymptom);
    const report = createRunHealthReport({
      runId,
      clusterId,
      firstSymptom: first,
      sourceActor,
      repoRoot,
    });
    return rest.reduce(
      (acc, sym) => appendSymptom(runId, sym, repoRoot),
      report,
    );
  }

  return symptoms
    .map(toRunHealthSymptom)
    .reduce(
      (acc: RunHealthReport, sym) => appendSymptom(runId, sym, repoRoot),
      existing,
    );
}

/**
 * Maps a worker symptom category to a run-health severity level.
 * Category-to-severity is intentionally opinionated but not final —
 * Medic may re-classify during triage.
 */
function mapCategoryToSeverity(category: WorkerRunHealthSymptom['category']): import('./schema.js').SymptomSeverity {
  switch (category) {
    case 'worker-blocked':    return 'high';
    case 'validation-failed': return 'high';
    case 'repeated-rework':   return 'medium';
    case 'unclear-requirements': return 'medium';
    case 'unusual-assumption':   return 'low';
    default: return 'medium';
  }
}

// ──────────────────────────────────────────────
// Re-export schema types and validation for consumers
// ──────────────────────────────────────────────
/**
 * Returns true when a run-health report has a satisfied Medic gate:
 * either a resolved/bypassed decision, or an explicit policy bypass.
 * Used by both loop/parent.ts and finalize/medic-gate.ts to ensure
 * consistent gate evaluation.
 */
export function isMedicGateSatisfied(report: RunHealthReport): boolean {
  const status = report.medic_consult?.status;
  if (status === "resolved" || status === "bypassed") return true;
  if (report.policy_bypass) return true;
  return false;
}

export * from "./schema.js";
export * from "./foreman-symptoms.js";
export * from "./qc-escalation.js";
