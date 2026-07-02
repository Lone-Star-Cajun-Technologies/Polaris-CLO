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
}

// ──────────────────────────────────────────────
// Diagnosis report types
// ──────────────────────────────────────────────

export interface DiagnosisHint {
  gate: string;
  fix_zone: string;
  hint: string;
}

export interface DiagnosisReport {
  run_id: string;
  cluster_id: string | null;
  evaluated_at: string;
  gate_results: GateResult[];
  failed_gates: string[];
  score: number;
  diagnosis_hints: DiagnosisHint[];
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

  return {
    runId,
    runDir,
    clusterDir,
    currentState,
    ledgerEvents,
    resultPackets,
    workerResultContracts,
    telemetryEvents,
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

// ──────────────────────────────────────────────
// Main entry point
// ──────────────────────────────────────────────

export function scoreRun(repoRoot: string, runId: string): DiagnosisReport {
  const artifacts = loadRunArtifacts(repoRoot, runId);

  const gateResults = ALL_GATES.map((evaluator) => evaluator(artifacts));
  const failedGates = gateResults.filter((g) => g.outcome === "failed").map((g) => g.gate);
  const score = computeScore(gateResults);
  const diagnosisHints = buildDiagnosisHints(failedGates);

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
  };
}
