/**
 * Autoresearch scoring engine.
 *
 * Reads run artifacts, evaluates binary gates, and produces a structured
 * diagnosis report:
 *
 *   {
 *     run_id, cluster_id, evaluated_at,
 *     gate_results: GateResult[],
 *     failed_gates: string[],
 *     score: number (0.0–1.0),
 *     diagnosis_hints: { gate, fix_zone, hint }[]
 *   }
 *
 * Score = passed_gates / evaluable_gates (skipped gates are not counted).
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { WorkerResultContract } from "../types/result-packet.js";
import { listQcArtifactIds, readQcArtifact } from "../qc/artifacts.js";
import type { QcResult } from "../qc/types.js";
import { ALL_GATES, readJsonLines } from "./gates.js";
import type { GateResult } from "./gates.js";

// ──────────────────────────────────────────────
// Artifact loading types
// ──────────────────────────────────────────────

export interface RunArtifacts {
  runId: string;
  runDir: string | null;
  clusterDir: string | null;
  currentState: unknown;
  ledgerEvents: unknown[];
  resultPackets: unknown[];
  workerResultContracts: WorkerResultContract[];
  telemetryEvents: unknown[];
  /** QC results loaded from .polaris/clusters/<cluster-id>/qc/. Empty when no QC data exists. */
  qcResults: QcResult[];
}

// ──────────────────────────────────────────────
// Diagnosis report types
// ──────────────────────────────────────────────

export interface DiagnosisHint {
  gate: string;
  fix_zone: string;
  hint: string;
}

export interface RouterFailureSummary {
  reason: string;
  occurrences: number;
  child_ids: string[];
}

export interface RouterOutcomesSummary {
  total_decisions: number;
  exhausted_decisions: number;
  fallback_attempts: number;
  successful_fallbacks: number;
  recurring_failures: RouterFailureSummary[];
}

/** Per-severity breakdown of QC findings for scoring. */
export interface QcFindingCounts {
  critical: number;
  high: number;
  medium: number;
  low: number;
  info: number;
}

/** QC scoring summary attached to the DiagnosisReport. */
export interface QcScoreSummary {
  /** Total findings across all QC runs for this cluster. */
  total_findings: number;
  /** Findings that block delivery (critical/high, open or follow-up, attributed with high/medium confidence). */
  blocking_findings: number;
  /** Findings autofixed by Polaris. */
  autofixed_findings: number;
  /** Findings routed to a repair worker. */
  repaired_findings: number;
  /** Findings waived by operator policy. */
  waived_findings: number;
  /** Findings from unvalidated / provider-noise sources (low-attribution confidence). */
  unvalidated_findings: number;
  /** Breakdown of open (non-waived, non-fixed) findings by severity. */
  open_by_severity: QcFindingCounts;
  /** Whether any QC run reported policyDecision.blocksDelivery = true. */
  blocks_delivery: boolean;
  /** Number of QC runs included in this summary. */
  qc_run_count: number;
}

export interface DiagnosisReport {
  run_id: string;
  cluster_id: string | null;
  evaluated_at: string;
  gate_results: GateResult[];
  failed_gates: string[];
  score: number;
  diagnosis_hints: DiagnosisHint[];
  router_outcomes: RouterOutcomesSummary;
  /** QC scoring summary. Present when QC artifacts exist for the cluster; null otherwise. */
  qc_summary: QcScoreSummary | null;
}

// ──────────────────────────────────────────────
// Diagnosis hints table
// ──────────────────────────────────────────────

const HINTS: Record<string, { fix_zone: string; hint: string }> = {
  "user-intervened": {
    fix_zone: "worker-prompt / packet-scope",
    hint: "User pushed commits after polaris-finalize. Review the worker packet scope and instructions for ambiguity.",
  },
  "foreman-resent-packet": {
    fix_zone: "foreman-dispatch / dispatch-boundary",
    hint: "Foreman dispatched the same child more than once. Check for state-machine bugs in dispatch-boundary.ts or loop continue logic.",
  },
  "foreman-fixed-worker-output": {
    fix_zone: "worker-prompt / scope-contract",
    hint: "Foreman made corrective commits after child-complete. Tighten the worker packet's allowed_scope and acceptance criteria.",
  },
  "worker-output-required-fixing": {
    fix_zone: "worker-prompt / validation-commands",
    hint: "Post-finalize commits indicate worker output was insufficient. Add stricter validation commands to the worker packet.",
  },
  "validation-failed": {
    fix_zone: "worker-validation / build-setup",
    hint: "One or more children failed validation. Check the validation_commands in the worker packet and the worker's implementation.",
  },
  "worker-went-out-of-scope": {
    fix_zone: "worker-packet / scope-contract",
    hint: "Worker emitted out-of-scope blocks or returned blocked status. Narrow allowed_scope in the worker packet.",
  },
  "foreman-token-burn-over-budget": {
    fix_zone: "bootstrap-context / prompt-size",
    hint: "Foreman bootstrap context exceeds token budget. Reduce current-state.json or worker packet size before dispatch.",
  },
  "state-repair-required": {
    fix_zone: "medic / cluster-state",
    hint: "Medic artifacts detected — state repair was required during this run. Review the medic chart and root cause.",
  },
  "qc-blocking-findings": {
    fix_zone: "qc / findings",
    hint: "QC produced unresolved critical/high findings attributed to this run. Review QC artifacts, triage findings, and route repairs before delivery.",
  },
};

// ──────────────────────────────────────────────
// Artifact loader
// ──────────────────────────────────────────────

function findRunDir(repoRoot: string, runId: string): string | null {
  // Standard taskchain location
  const taskchainPath = join(repoRoot, ".taskchain_artifacts", "polaris-run", "runs", runId);
  if (existsSync(taskchainPath)) return taskchainPath;

  // Legacy .polaris/runs location
  const polarisPath = join(repoRoot, ".polaris", "runs", runId);
  if (existsSync(polarisPath)) return polarisPath;

  return null;
}

function findClusterDir(repoRoot: string, clusterId: string): string | null {
  const path = join(repoRoot, ".polaris", "clusters", clusterId);
  return existsSync(path) ? path : null;
}

function readJson(filePath: string): unknown {
  try {
    return JSON.parse(readFileSync(filePath, "utf-8"));
  } catch {
    return undefined;
  }
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

const NON_WORKER_PREFIXES = ["librarian-", "CHART-", "medic-result-"];

function loadQcArtifacts(clusterId: string | null, repoRoot: string): QcResult[] {
  if (!clusterId) return [];
  const ids = listQcArtifactIds(clusterId, repoRoot);
  const results: QcResult[] = [];
  for (const id of ids) {
    const result = readQcArtifact(clusterId, id, repoRoot);
    if (result) results.push(result);
  }
  return results;
}

function readResultPackets(clusterDir: string | null): unknown[] {
  if (!clusterDir) return [];
  const resultsDir = join(clusterDir, "results");
  if (!existsSync(resultsDir)) return [];
  return safeReaddir(resultsDir)
    .filter((f) => f.endsWith(".json") && !NON_WORKER_PREFIXES.some((p) => f.startsWith(p)))
    .map((f) => readJson(join(resultsDir, f)))
    .filter((v) => v !== undefined);
}

function extractWorkerResultContracts(resultPackets: unknown[]): WorkerResultContract[] {
  const contracts: WorkerResultContract[] = [];
  for (const packet of resultPackets) {
    const rec = packet as Record<string, unknown> | null;
    // WorkerResultContract has packet_hash, worker_id, role as distinguishing fields
    if (rec && typeof rec["packet_hash"] === "string" && typeof rec["worker_id"] === "string") {
      contracts.push(rec as unknown as WorkerResultContract);
    }
  }
  return contracts;
}

export function loadRunArtifacts(repoRoot: string, runId: string): RunArtifacts {
  const runDir = findRunDir(repoRoot, runId);

  // Derive cluster from current-state.json in the run dir, or fallback to the default
  let clusterId: string | null = null;
  let currentState: unknown = null;

  // Try run dir's current-state.json first
  if (runDir) {
    const runStatePath = join(runDir, "current-state.json");
    if (existsSync(runStatePath)) {
      currentState = readJson(runStatePath);
    }
  }

  // Fall back to the active current-state.json
  if (!currentState) {
    const taskchainState = join(repoRoot, ".taskchain_artifacts", "polaris-run", "current-state.json");
    const polarisState = join(repoRoot, ".polaris", "runs", "current-state.json");
    const statePath = existsSync(taskchainState) ? taskchainState : polarisState;
    if (existsSync(statePath)) {
      currentState = readJson(statePath);
    }
  }

  if (currentState && typeof currentState === "object" && currentState !== null) {
    const rec = currentState as Record<string, unknown>;
    if (typeof rec["cluster_id"] === "string") clusterId = rec["cluster_id"];
    if (typeof rec["run_id"] === "string" && rec["run_id"] !== runId) {
      // State belongs to a different run — don't use it for cluster_id derivation
      clusterId = null;
    }
  }

  const clusterDir = clusterId ? findClusterDir(repoRoot, clusterId) : null;

  // Ledger
  const ledgerPath = join(repoRoot, ".polaris", "runs", "ledger.jsonl");
  const ledgerEvents = readJsonLines(ledgerPath).filter((e) => {
    const rec = e as Record<string, unknown> | null;
    return rec?.["run_id"] === runId;
  });

  // Telemetry — prefer the run dir; some older runs have it in .polaris/runs/<runId>/
  const telemetryPath = runDir ? join(runDir, "telemetry.jsonl") : null;
  const telemetryEvents = telemetryPath ? readJsonLines(telemetryPath) : [];

  // Result packets from cluster results dir
  const resultPackets = readResultPackets(clusterDir);

  // WorkerResultContracts: prefer completed_children_results from current-state.json (Bug A fix)
  let workerResultContracts: WorkerResultContract[];
  const stateRec =
    currentState && typeof currentState === "object" && currentState !== null
      ? (currentState as Record<string, unknown>)
      : null;
  const completedChildrenResults = stateRec?.["completed_children_results"];
  if (completedChildrenResults && typeof completedChildrenResults === "object" && !Array.isArray(completedChildrenResults)) {
    workerResultContracts = Object.values(completedChildrenResults as Record<string, unknown>).filter(
      (v): v is WorkerResultContract =>
        v !== null && typeof v === "object" && typeof (v as Record<string, unknown>)["worker_id"] === "string",
    );
    // If filtering produced zero contracts, fall back to legacy extraction
    if (workerResultContracts.length === 0) {
      workerResultContracts = extractWorkerResultContracts(resultPackets);
    }
  } else {
    // Legacy fallback: extract from result packet files
    workerResultContracts = extractWorkerResultContracts(resultPackets);
  }

  const qcResults = loadQcArtifacts(clusterId, repoRoot);

  return {
    runId,
    runDir,
    clusterDir,
    currentState,
    ledgerEvents,
    resultPackets,
    workerResultContracts,
    telemetryEvents,
    qcResults,
  };
}

// ──────────────────────────────────────────────
// Scoring
// ──────────────────────────────────────────────

export function computeScore(gateResults: GateResult[]): number {
  const evaluable = gateResults.filter((g) => g.outcome !== "skipped");
  if (evaluable.length === 0) return 1.0; // nothing to evaluate — no known problems
  const passed = evaluable.filter((g) => g.outcome === "passed").length;
  return passed / evaluable.length;
}

export function buildDiagnosisHints(failedGateNames: string[]): DiagnosisHint[] {
  return failedGateNames.map((gate) => {
    const h = HINTS[gate] ?? { fix_zone: "unknown", hint: `Gate ${gate} failed — no hint available.` };
    return { gate, ...h };
  });
}

/**
 * Computes a QcScoreSummary from the QC results loaded for this run.
 * Returns null when no QC results are present.
 *
 * A finding is "blocking" if:
 *   - severity is critical or high
 *   - status is "open" or "follow-up" (not autofixed, repaired, or waived)
 *   - attribution confidence is "high" or "medium" (not unvalidated provider noise)
 *
 * Worker scoring intentionally does not penalize for "unvalidated" or
 * "low" attribution-confidence findings — these are treated as provider noise.
 */
export function computeQcSummary(qcResults: QcResult[]): QcScoreSummary | null {
  if (qcResults.length === 0) return null;

  const zeroCounts = (): QcFindingCounts => ({ critical: 0, high: 0, medium: 0, low: 0, info: 0 });

  let total = 0;
  let blocking = 0;
  let autofixed = 0;
  let repaired = 0;
  let waived = 0;
  let unvalidated = 0;
  const openBySeverity = zeroCounts();
  let blocksDelivery = false;

  for (const result of qcResults) {
    if (result.policyDecision.blocksDelivery) blocksDelivery = true;
    for (const finding of result.findings) {
      total++;

      const conf = finding.attribution.confidence;
      const isUnvalidated = conf === "low" || conf === "unattributed";
      if (isUnvalidated) {
        unvalidated++;
        continue; // do not count provider noise toward any negative bucket
      }

      if (finding.status === "autofixed") { autofixed++; continue; }
      if (finding.status === "repaired") { repaired++; continue; }
      if (finding.status === "waived") { waived++; continue; }

      // "open" or "follow-up" — count toward open_by_severity
      const sev = finding.severity;
      if (sev in openBySeverity) openBySeverity[sev as keyof QcFindingCounts]++;

      if ((sev === "critical" || sev === "high") && (finding.status === "open" || finding.status === "follow-up")) {
        blocking++;
      }
    }
  }

  return {
    total_findings: total,
    blocking_findings: blocking,
    autofixed_findings: autofixed,
    repaired_findings: repaired,
    waived_findings: waived,
    unvalidated_findings: unvalidated,
    open_by_severity: openBySeverity,
    blocks_delivery: blocksDelivery,
    qc_run_count: qcResults.length,
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

export function summarizeRouterOutcomes(artifacts: RunArtifacts): RouterOutcomesSummary {
  const telemetry = artifacts.telemetryEvents
    .map((event) => asRecord(event))
    .filter((event): event is Record<string, unknown> => event !== undefined);

  const childCompletionStatus = new Map<string, string>();
  for (const event of telemetry) {
    if (event["event"] !== "child-complete" || typeof event["child_id"] !== "string") continue;
    const completionStatus =
      typeof event["completion_status"] === "string"
        ? event["completion_status"]
        : "done";
    childCompletionStatus.set(event["child_id"], completionStatus);
  }

  const selectedEvents = telemetry.filter((event) => event["event"] === "provider-selected");
  const exhaustedEvents = telemetry.filter((event) => event["event"] === "provider-exhausted");
  const fallbackEvents = telemetry.filter((event) => event["event"] === "provider-fallback-attempted");
  const reasonCounts = new Map<string, { count: number; childIds: Set<string> }>();

  const countReason = (reason: string, childId?: string): void => {
    const current = reasonCounts.get(reason) ?? { count: 0, childIds: new Set<string>() };
    current.count += 1;
    if (childId) current.childIds.add(childId);
    reasonCounts.set(reason, current);
  };

  for (const event of exhaustedEvents) {
    const reason = typeof event["reason"] === "string" ? event["reason"] : "no-provider-selected";
    const childId = typeof event["child_id"] === "string" ? event["child_id"] : undefined;
    countReason(reason, childId);
  }

  for (const event of selectedEvents) {
    const childId = typeof event["child_id"] === "string" ? event["child_id"] : undefined;
    const selectedProvider = typeof event["selected_provider"] === "string" ? event["selected_provider"] : null;
    if (!selectedProvider) {
      // Use per-candidate rejection reasons when available; fall back to the
      // overall exhausted reason. Counting both for the same event would
      // double-count shared reason strings (e.g. "no-slot").
      const candidates = Array.isArray(event["router_candidates"]) ? event["router_candidates"] : [];
      if (candidates.length > 0) {
        for (const candidateRaw of candidates) {
          const candidate = asRecord(candidateRaw);
          if (!candidate) continue;
          const rejectionReasons = asStringArray(candidate["rejection_reasons"]);
          for (const reason of rejectionReasons) {
            countReason(reason, childId);
          }
        }
      } else {
        const exhaustedReason =
          typeof event["router_exhausted_reason"] === "string"
            ? event["router_exhausted_reason"]
            : "no-provider-selected";
        countReason(exhaustedReason, childId);
      }
    }
  }

  let successfulFallbacks = 0;
  for (const event of selectedEvents) {
    const selectedProvider = typeof event["selected_provider"] === "string" ? event["selected_provider"] : null;
    const providersTried = asStringArray(event["providers_tried"]);
    const usedFallback = selectedProvider !== null && providersTried.length > 1;
    if (!usedFallback) continue;
    const childId = typeof event["child_id"] === "string" ? event["child_id"] : undefined;
    const completionStatus = childId ? childCompletionStatus.get(childId) : undefined;
    if (completionStatus && completionStatus !== "blocked" && completionStatus !== "error") {
      successfulFallbacks += 1;
    }
  }

  const recurringFailures = Array.from(reasonCounts.entries())
    .map(([reason, value]) => ({
      reason,
      occurrences: value.count,
      child_ids: Array.from(value.childIds).sort(),
    }))
    .sort((a, b) => b.occurrences - a.occurrences || a.reason.localeCompare(b.reason));

  return {
    total_decisions: selectedEvents.length,
    exhausted_decisions: exhaustedEvents.length,
    fallback_attempts: fallbackEvents.length,
    successful_fallbacks: successfulFallbacks,
    recurring_failures: recurringFailures,
  };
}

// ──────────────────────────────────────────────
// Main entry point
// ──────────────────────────────────────────────

export function scoreRun(repoRoot: string, runId: string): DiagnosisReport {
  const artifacts = loadRunArtifacts(repoRoot, runId);

  const gateResults = ALL_GATES.map((evaluator) => evaluator(artifacts));
  const failedGates = gateResults.filter((g) => g.outcome === "failed").map((g) => g.gate);
  const score = computeScore(gateResults);
  const diagnosisHints = buildDiagnosisHints(failedGates);
  const routerOutcomes = summarizeRouterOutcomes(artifacts);
  const qcSummary = computeQcSummary(artifacts.qcResults);

  const clusterId =
    artifacts.currentState &&
    typeof artifacts.currentState === "object" &&
    !Array.isArray(artifacts.currentState)
      ? ((artifacts.currentState as Record<string, unknown>)["cluster_id"] as string | null) ?? null
      : null;

  return {
    run_id: runId,
    cluster_id: clusterId,
    evaluated_at: new Date().toISOString(),
    gate_results: gateResults,
    failed_gates: failedGates,
    score,
    diagnosis_hints: diagnosisHints,
    router_outcomes: routerOutcomes,
    qc_summary: qcSummary,
  };
}
