import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  MedicTreatmentPacket,
  TreatmentWorkerResult,
} from "../types/result-packet.js";
import type { WorkerPacket } from "../loop/worker-packet.js";
import { compileRepairWorkerPacket } from "../loop/worker-packet.js";
import type { RunHealthReport, RunHealthSymptom } from "../run-health/schema.js";

/** Default validation commands embedded in treatment packets. */
export const DEFAULT_TREATMENT_VALIDATION_COMMANDS: string[] = [
  "npm run build",
  "npm test",
];

/** Paths a treatment worker must never touch. */
export const DEFAULT_TREATMENT_PROHIBITED_SCOPE: string[] = [
  ".polaris/**",
  ".taskchain_artifacts/**",
  "**/telemetry.jsonl",
];

export interface BuildTreatmentPacketsInput {
  report: RunHealthReport;
  round: number;
  repoRoot: string;
  validationCommands?: string[];
}

/**
 * Return the cluster-scoped Medic directory where treatment packets are persisted.
 */
export function getMedicDir(clusterId: string, repoRoot: string): string {
  return join(repoRoot, ".polaris", "clusters", clusterId, "medic");
}

/**
 * Build a deterministic treatment packet id from run id, round, and symptom.
 */
export function buildTreatmentPacketId(
  runId: string,
  round: number,
  symptomId: string,
): string {
  const base = `${runId}-r${round}-${symptomId}`;
  return base.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/**
 * Determine whether a symptom should receive a treatment packet.
 */
function symptomNeedsTreatment(symptom: RunHealthSymptom): boolean {
  return symptom.severity === "critical" || symptom.severity === "high";
}

/**
 * Derive an allowed file scope from symptom evidence refs.
 * Falls back to the repository root when no concrete refs are present.
 */
function scopeFromEvidenceRefs(refs: string[]): string[] {
  const fileRefs = refs.filter((ref) => ref.includes("/") || ref.includes("."));
  return fileRefs.length > 0 ? fileRefs : ["."];
}

/**
 * Build treatment packets for every symptom that needs treatment in the report.
 */
export function buildTreatmentPackets(
  input: BuildTreatmentPacketsInput,
): MedicTreatmentPacket[] {
  const { report, round, repoRoot, validationCommands } = input;
  const treated = report.symptoms.filter(symptomNeedsTreatment);

  return treated.map((symptom) => {
    const packetId = buildTreatmentPacketId(report.run_id, round, symptom.id);
    const dispatchId = randomUUID();
    const resultFile = relative(
      repoRoot,
      join(getMedicDir(report.cluster_id, repoRoot), `${packetId}-result.json`),
    );

    return {
      packet_id: packetId,
      run_id: report.run_id,
      cluster_id: report.cluster_id,
      round,
      source_symptom_ids: [symptom.id],
      allowed_scope: scopeFromEvidenceRefs(symptom.evidence_refs),
      prohibited_scope: DEFAULT_TREATMENT_PROHIBITED_SCOPE,
      validation_commands: validationCommands ?? DEFAULT_TREATMENT_VALIDATION_COMMANDS,
      root_cause_hint: `Run-health symptom ${symptom.code}: ${symptom.message}`,
      dispatch_metadata: {
        dispatch_id: dispatchId,
        worker_id: `${report.run_id}:treatment:${packetId}:${Date.now()}`,
        result_file: resultFile,
      },
      status: "pending",
    };
  });
}

export interface CompileTreatmentWorkerPacketInput {
  treatment: MedicTreatmentPacket;
  stateFile: string;
  telemetryFile: string;
  branch: string;
  maxConcurrentWorkers?: number;
}

/**
 * Compile a Medic treatment packet into a normal Foreman WorkerPacket.
 *
 * The resulting packet uses `worker_role: "repair"` so it re-enters the same
 * dispatch path as QC repair workers, with no special implementation behavior.
 */
export function compileTreatmentWorkerPacket(
  input: CompileTreatmentWorkerPacketInput,
): WorkerPacket {
  const { treatment, stateFile, telemetryFile, branch, maxConcurrentWorkers } = input;

  return compileRepairWorkerPacket({
    runId: treatment.run_id,
    clusterId: treatment.cluster_id,
    packetId: treatment.packet_id,
    branch,
    stateFile,
    telemetryFile,
    round: treatment.round,
    allowedScope: treatment.allowed_scope,
    prohibitedScope: treatment.prohibited_scope,
    validationCommands: treatment.validation_commands,
    rootCauseHint: treatment.root_cause_hint,
    resultFile: treatment.dispatch_metadata.result_file,
    maxConcurrentWorkers,
  });
}

export interface WriteTreatmentPacketInput {
  treatment: MedicTreatmentPacket;
  repoRoot: string;
}

/**
 * Persist a treatment packet to disk and return its repo-relative path.
 */
export function writeTreatmentPacket(input: WriteTreatmentPacketInput): string {
  const { treatment, repoRoot } = input;
  const dir = getMedicDir(treatment.cluster_id, repoRoot);
  const filePath = join(dir, `${treatment.packet_id}.json`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, JSON.stringify(treatment, null, 2), "utf-8");
  return filePath;
}

/**
 * Parse a treatment worker summary from a dispatch result summary string.
 */
export function parseTreatmentWorkerSummary(
  summary: string | undefined,
): { status: "done" | "failure" | "blocked"; commit?: string; error_message?: string } | null {
  if (!summary) return null;
  try {
    const parsed = JSON.parse(summary) as Record<string, unknown>;
    const status = String(parsed["status"] ?? "").toLowerCase();
    const commit = typeof parsed["commit"] === "string" ? parsed["commit"] : undefined;
    const error_message =
      typeof parsed["error_message"] === "string" ? parsed["error_message"] : undefined;
    if (status === "done" || status === "success") {
      return { status: "done", commit, error_message };
    }
    if (status === "blocked") {
      return { status: "blocked", commit, error_message };
    }
    return { status: "failure", commit, error_message };
  } catch {
    return null;
  }
}

export interface DispatchTreatmentWorkerInput {
  treatment: MedicTreatmentPacket;
  stateFile: string;
  telemetryFile: string;
  branch: string;
  repoRoot: string;
  dispatch: (packet: WorkerPacket) => Promise<{ exit_code: number; summary?: string }>;
  maxConcurrentWorkers?: number;
}

/**
 * Dispatch a single treatment worker through the normal Foreman adapter and
 * return a normalized treatment result.
 */
export async function dispatchTreatmentWorker(
  input: DispatchTreatmentWorkerInput,
): Promise<TreatmentWorkerResult> {
  const { treatment, stateFile, telemetryFile, branch, repoRoot, dispatch, maxConcurrentWorkers } =
    input;

  writeTreatmentPacket({ treatment, repoRoot });

  const workerPacket = compileTreatmentWorkerPacket({
    treatment,
    stateFile,
    telemetryFile,
    branch,
    maxConcurrentWorkers,
  });

  const result = await dispatch(workerPacket);
  const summary = parseTreatmentWorkerSummary(result.summary);

  if (result.exit_code === 0 && summary?.status === "done") {
    const completedTreatment = { ...treatment, status: "completed" as const };
    writeTreatmentPacket({ treatment: completedTreatment, repoRoot });
    return {
      packet_id: treatment.packet_id,
      status: "success",
      commit_sha: summary.commit,
    };
  }

  const failedTreatment = { ...treatment, status: "failed" as const };
  writeTreatmentPacket({ treatment: failedTreatment, repoRoot });
  return {
    packet_id: treatment.packet_id,
    status: "failure",
    error_message:
      summary?.error_message ??
      (result.exit_code === 0 ? "treatment worker returned non-done status" : "dispatch failed"),
  };
}
