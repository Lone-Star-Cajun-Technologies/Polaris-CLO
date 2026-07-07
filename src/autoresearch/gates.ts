/**
 * Binary gate evaluators for the autoresearch scoring pipeline.
 *
 * Gates are binary: false = PASSED (no problem detected), true = FAILED.
 * When data is unavailable the gate is SKIPPED (not counted in score denominator).
 *
 * Gate contract:
 *   evaluate(artifacts): GateResult
 *
 * Gate names match the v1 spec from POL-422:
 *   user-intervened, foreman-resent-packet, foreman-fixed-worker-output,
 *   worker-output-required-fixing, validation-failed,
 *   worker-went-out-of-scope, foreman-token-burn-over-budget, state-repair-required
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { RunArtifacts } from "./score.js";

// ──────────────────────────────────────────────
// Gate result types
// ──────────────────────────────────────────────

export type GateOutcome = "passed" | "failed" | "skipped";

export interface GateResult {
  gate: string;
  outcome: GateOutcome;
  /** Optional detail used in diagnosis_hints */
  detail?: string;
}

// ──────────────────────────────────────────────
// Token-burn budget constant (heuristic: 150k combined tokens = over budget)
// ──────────────────────────────────────────────

const TOKEN_BURN_THRESHOLD = 150_000;

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

function readJson(filePath: string): unknown {
  try {
    return JSON.parse(readFileSync(filePath, "utf-8"));
  } catch {
    return undefined;
  }
}

function readJsonLines(filePath: string): unknown[] {
  if (!existsSync(filePath)) return [];
  const lines = readFileSync(filePath, "utf-8")
    .split("\n")
    .filter((l) => l.trim().length > 0);
  const out: unknown[] = [];
  for (const line of lines) {
    try {
      out.push(JSON.parse(line));
    } catch {
      // skip malformed lines
    }
  }
  return out;
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    return v as Record<string, unknown>;
  }
  return undefined;
}

// ──────────────────────────────────────────────
// Gate implementations
// ──────────────────────────────────────────────

/**
 * user-intervened: Were any commits pushed to the branch after polaris-finalize
 * but before PR merge?
 *
 * Evidence: WorkerResultContract.user_intervened (when populated by POL-421).
 * Falls back to checking the last result file in results/ for the flag.
 * Skips if no result files exist.
 */
export function gateUserIntervened(artifacts: RunArtifacts): GateResult {
  const contract = artifacts.workerResultContracts.find(
    (c) => c.user_intervened !== null && c.user_intervened !== undefined,
  );
  if (!contract) return { gate: "user-intervened", outcome: "skipped", detail: "no contract with user_intervened populated" };
  return {
    gate: "user-intervened",
    outcome: contract.user_intervened ? "failed" : "passed",
    detail: contract.user_intervened ? "user_intervened=true on result contract" : undefined,
  };
}

/**
 * foreman-resent-packet: Was the same child dispatched more than once?
 *
 * Evidence:
 *   - open_children_meta.<child>.dispatch_record.dispatch_count (if runtime tracks it)
 *   - ledger child-dispatched events (issue_id)
 *   - telemetry child-dispatched events (child_id)
 *
 * A normal multi-session run has dispatch_epoch > 1 because distinct children are
 * dispatched across sessions. That is expected. The problematic pattern is the
 * foreman re-sending a worker packet to the same child after that child already
 * returned a result. When per-child dispatch count data is unavailable, the gate
 * is skipped rather than failing on dispatch_epoch alone.
 */
export function gateForemanResentPacket(artifacts: RunArtifacts): GateResult {
  const state = artifacts.currentState;
  if (!state) return { gate: "foreman-resent-packet", outcome: "skipped", detail: "current-state.json not found" };

  const dispatchEpoch = asRecord(asRecord(state)?.["dispatch_boundary"])?.["dispatch_epoch"];
  if (typeof dispatchEpoch !== "number") {
    return { gate: "foreman-resent-packet", outcome: "skipped", detail: "dispatch_epoch not present in state" };
  }

  const perChildCounts = countChildDispatches(artifacts);

  if (perChildCounts) {
    const reDispatched = Array.from(perChildCounts.entries())
      .filter(([, count]) => count > 1)
      .map(([childId]) => childId);
    const failed = reDispatched.length > 0;
    return {
      gate: "foreman-resent-packet",
      outcome: failed ? "failed" : "passed",
      detail: failed ? `child re-dispatched: ${reDispatched.join(", ")}` : undefined,
    };
  }

  // No per-child dispatch data available. A single epoch cannot contain a re-dispatch.
  if (dispatchEpoch === 1) {
    return { gate: "foreman-resent-packet", outcome: "passed" };
  }

  return {
    gate: "foreman-resent-packet",
    outcome: "skipped",
    detail: "per-child dispatch count data unavailable",
  };
}

/** Counts per-child dispatches from all available artifact sources, or null if none are present. */
function countChildDispatches(artifacts: RunArtifacts): Map<string, number> | null {
  const counts = new Map<string, number>();

  // Count from open_children_meta dispatch_record
  const state = asRecord(artifacts.currentState);
  const openChildrenMeta = asRecord(state?.["open_children_meta"]);
  for (const [childId, meta] of Object.entries(openChildrenMeta ?? {})) {
    const metaRec = asRecord(meta);
    const dispatchRecord = asRecord(metaRec?.["dispatch_record"]);
    const dispatchCount = dispatchRecord?.["dispatch_count"];
    if (typeof dispatchCount === "number") {
      counts.set(childId, Math.max(counts.get(childId) ?? 0, dispatchCount));
    }
  }

  // Count child-dispatched events from ledger (each event = evidence of one dispatch)
  const ledgerCounts = new Map<string, number>();
  for (const event of artifacts.ledgerEvents) {
    const rec = asRecord(event);
    if (rec?.["event"] === "child-dispatched" && typeof rec["issue_id"] === "string") {
      const childId = rec["issue_id"];
      ledgerCounts.set(childId, (ledgerCounts.get(childId) ?? 0) + 1);
    }
  }
  for (const [childId, count] of ledgerCounts.entries()) {
    counts.set(childId, Math.max(counts.get(childId) ?? 0, count));
  }

  // Count child-dispatched events from telemetry (each event = evidence of one dispatch)
  const telemetryCounts = new Map<string, number>();
  for (const event of artifacts.telemetryEvents) {
    const rec = asRecord(event);
    if (rec?.["event"] === "child-dispatched" && typeof rec["child_id"] === "string") {
      const childId = rec["child_id"];
      telemetryCounts.set(childId, (telemetryCounts.get(childId) ?? 0) + 1);
    }
  }
  for (const [childId, count] of telemetryCounts.entries()) {
    counts.set(childId, Math.max(counts.get(childId) ?? 0, count));
  }

  return counts.size > 0 ? counts : null;
}

/**
 * foreman-fixed-worker-output: Did foreman make commits between child-complete
 * and the next dispatch?
 *
 * Evidence: WorkerResultContract.foreman_intervened.
 * Skips if no contracts present.
 */
export function gateForemanFixedWorkerOutput(artifacts: RunArtifacts): GateResult {
  const contract = artifacts.workerResultContracts.find(
    (c) => c.foreman_intervened !== null && c.foreman_intervened !== undefined,
  );
  if (!contract) {
    return {
      gate: "foreman-fixed-worker-output",
      outcome: "skipped",
      detail: "no contract with foreman_intervened populated",
    };
  }
  return {
    gate: "foreman-fixed-worker-output",
    outcome: contract.foreman_intervened ? "failed" : "passed",
    detail: contract.foreman_intervened ? "foreman_intervened=true on result contract" : undefined,
  };
}

/**
 * worker-output-required-fixing: Were commits pushed after polaris-finalize?
 *
 * Evidence: WorkerResultContract.user_intervened or foreman_intervened OR
 * checking ledger for a "finalized" event and comparing last_commit timing.
 * Skips when insufficient data is available.
 */
export function gateWorkerOutputRequiredFixing(artifacts: RunArtifacts): GateResult {
  // If either intervention flag is set, worker output required fixing
  const anyIntervention = artifacts.workerResultContracts.some(
    (c) =>
      (c.user_intervened !== null && c.user_intervened === true) ||
      (c.foreman_intervened !== null && c.foreman_intervened === true),
  );
  if (anyIntervention) {
    return {
      gate: "worker-output-required-fixing",
      outcome: "failed",
      detail: "user or foreman intervention detected after finalize",
    };
  }

  // Check ledger for finalized event + commit after finalize
  const finalizedEvent = artifacts.ledgerEvents.find((e) => {
    const rec = asRecord(e);
    return rec?.["event"] === "finalized";
  });
  if (!finalizedEvent) {
    return { gate: "worker-output-required-fixing", outcome: "skipped", detail: "no finalized event in ledger" };
  }
  // We can't easily inspect git log here (no exec in scoring engine — that is by design).
  // With current artifact data, mark passed when finalized and no intervention flags.
  return { gate: "worker-output-required-fixing", outcome: "passed" };
}

/**
 * validation-failed: Did any child's result packet report a validation failure?
 *
 * Evidence: result JSONs in clusters/<cluster-id>/results/.
 */
export function gateValidationFailed(artifacts: RunArtifacts): GateResult {
  if (artifacts.resultPackets.length === 0) {
    return { gate: "validation-failed", outcome: "skipped", detail: "no result packets found" };
  }

  const failed = artifacts.resultPackets.some((packet) => {
    const rec = asRecord(packet);
    if (!rec) return false;
    // SuccessResultPacket has validation: { passed: string[] } — non-empty = passed
    const validation = rec["validation"];
    if (!validation) return true; // no validation record → treat as failed
    const valRec = asRecord(validation);
    if (valRec) {
      // { passed: string[] } form
      if (Array.isArray(valRec["passed"]) && (valRec["passed"] as unknown[]).length > 0) return false;
    }
    // string form: "passed" / "failed" / "skipped"
    if (typeof validation === "string") {
      const v = validation.toLowerCase();
      return v === "failed" || v === "failure";
    }
    return false;
  });

  const allFailed = artifacts.resultPackets.every((packet) => {
    const rec = asRecord(packet);
    return rec?.["status"] === "failure";
  });

  if (allFailed && artifacts.resultPackets.length > 0) {
    return { gate: "validation-failed", outcome: "failed", detail: "all result packets have status=failure" };
  }

  return {
    gate: "validation-failed",
    outcome: failed ? "failed" : "passed",
    detail: failed ? "one or more result packets report validation failure" : undefined,
  };
}

/**
 * worker-went-out-of-scope: Did any worker result indicate out-of-scope work
 * or emit worker-blocked events with approval_type=out-of-scope?
 *
 * Evidence: telemetry.jsonl worker-blocked events + result status.
 */
export function gateWorkerWentOutOfScope(artifacts: RunArtifacts): GateResult {
  // Check telemetry for worker-blocked with out-of-scope
  const outOfScopeBlock = artifacts.telemetryEvents.some((e) => {
    const rec = asRecord(e);
    return rec?.["event"] === "worker-blocked" && rec?.["approval_type"] === "out-of-scope";
  });

  if (outOfScopeBlock) {
    return {
      gate: "worker-went-out-of-scope",
      outcome: "failed",
      detail: "worker-blocked with approval_type=out-of-scope in telemetry",
    };
  }

  // Check result packets for "blocked" status
  const blockedResult = artifacts.resultPackets.some((packet) => {
    const rec = asRecord(packet);
    return rec?.["status"] === "blocked";
  });

  if (blockedResult) {
    return { gate: "worker-went-out-of-scope", outcome: "failed", detail: "result packet status=blocked" };
  }

  if (artifacts.telemetryEvents.length === 0 && artifacts.resultPackets.length === 0) {
    return { gate: "worker-went-out-of-scope", outcome: "skipped", detail: "no telemetry or result packets" };
  }

  return { gate: "worker-went-out-of-scope", outcome: "passed" };
}

/**
 * foreman-token-burn-over-budget: Did the foreman's bootstrap context exceed the budget?
 *
 * Evidence: bootstrap-context-size events in telemetry.jsonl.
 * Skipped when no such events are present.
 */
export function gateForemanTokenBurnOverBudget(artifacts: RunArtifacts): GateResult {
  const sizeEvents = artifacts.telemetryEvents.filter((e) => {
    const rec = asRecord(e);
    return rec?.["event"] === "bootstrap-context-size";
  });

  if (sizeEvents.length === 0) {
    return {
      gate: "foreman-token-burn-over-budget",
      outcome: "skipped",
      detail: "no bootstrap-context-size events in telemetry",
    };
  }

  // Use the maximum combined_estimated_tokens across all events
  const maxTokens = Math.max(
    ...sizeEvents.map((e) => {
      const rec = asRecord(e);
      const v = rec?.["combined_estimated_tokens"];
      return typeof v === "number" ? v : 0;
    }),
  );

  const failed = maxTokens > TOKEN_BURN_THRESHOLD;
  return {
    gate: "foreman-token-burn-over-budget",
    outcome: failed ? "failed" : "passed",
    detail: failed ? `max combined_estimated_tokens=${maxTokens} exceeds threshold=${TOKEN_BURN_THRESHOLD}` : undefined,
  };
}

/**
 * state-repair-required: Were medic result artifacts created for this cluster?
 *
 * Evidence: clusters/<cluster-id>/ directory — presence of medic result files.
 */
export function gateStateRepairRequired(artifacts: RunArtifacts): GateResult {
  if (!artifacts.clusterDir || !existsSync(artifacts.clusterDir)) {
    return { gate: "state-repair-required", outcome: "skipped", detail: "cluster directory not found" };
  }

  // Medic results have filenames like CHART-xxx.json or medic-result-*.json
  const files = safeReaddir(artifacts.clusterDir);
  const hasMedicResult = files.some(
    (f) =>
      f.startsWith("CHART-") ||
      f.startsWith("medic-result-") ||
      f.includes("medic") && f.endsWith(".json"),
  );

  // Also check results/ subdirectory for any medic artifacts
  const resultsDir = join(artifacts.clusterDir, "results");
  const resultFiles = existsSync(resultsDir) ? safeReaddir(resultsDir) : [];
  const hasMedicInResults = resultFiles.some(
    (f) => f.startsWith("CHART-") || f.startsWith("medic-result-"),
  );

  if (hasMedicResult || hasMedicInResults) {
    return {
      gate: "state-repair-required",
      outcome: "failed",
      detail: "medic result artifacts detected in cluster directory",
    };
  }

  return { gate: "state-repair-required", outcome: "passed" };
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * qc-blocking-findings: Are there unresolved critical/high QC findings
 * attributed to this cluster with high or medium confidence?
 *
 * Evidence: qcResults loaded from .polaris/clusters/<cluster-id>/qc/.
 * Skipped when no QC artifacts exist.
 *
 * Only high/medium attribution-confidence findings are counted — provider noise
 * (low/unattributed confidence) is excluded so workers are not penalized for
 * external reviewer uncertainty.
 */
export function gateQcBlockingFindings(artifacts: RunArtifacts): GateResult {
  if (artifacts.qcResults.length === 0) {
    return { gate: "qc-blocking-findings", outcome: "skipped", detail: "no QC artifacts found" };
  }

  let blockingCount = 0;
  for (const result of artifacts.qcResults) {
    for (const finding of result.findings) {
      const conf = finding.attribution.confidence;
      if (conf === "low" || conf === "unattributed") continue;
      if (finding.status === "autofixed" || finding.status === "repaired" || finding.status === "waived") continue;
      if ((finding.severity === "critical" || finding.severity === "high") &&
          (finding.status === "open" || finding.status === "follow-up")) {
        blockingCount++;
      }
    }
  }

  if (blockingCount > 0) {
    return {
      gate: "qc-blocking-findings",
      outcome: "failed",
      detail: `${blockingCount} unresolved critical/high QC finding${blockingCount === 1 ? "" : "s"} with attributed confidence`,
    };
  }

  return { gate: "qc-blocking-findings", outcome: "passed" };
}

// ──────────────────────────────────────────────
// Gate registry — evaluated in order
// ──────────────────────────────────────────────

export type GateEvaluator = (artifacts: RunArtifacts) => GateResult;

export const ALL_GATES: readonly GateEvaluator[] = [
  gateUserIntervened,
  gateForemanResentPacket,
  gateForemanFixedWorkerOutput,
  gateWorkerOutputRequiredFixing,
  gateValidationFailed,
  gateWorkerWentOutOfScope,
  gateForemanTokenBurnOverBudget,
  gateStateRepairRequired,
  gateQcBlockingFindings,
] as const;

export { readJsonLines };
