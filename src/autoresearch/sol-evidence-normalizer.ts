/**
 * SOL evidence normalizer.
 *
 * Materializes raw metric events (SolMetricEvent[]) and source references
 * (SolSourceRef[]) from a loaded SolEvidence record. This is the bridge
 * between the evidence loader and scorecard generation.
 *
 * Design rules:
 *   - Never throws on missing data — absent optional fields reduce confidence.
 *   - Source refs track every artifact that contributed evidence (present or not).
 *   - Provider startup failures are distinguished from worker execution failures:
 *       startup failure = provider-exhausted or selected_provider=null in router evidence
 *       worker execution failure = worker ran but status="failed"|"error"
 *   - Router fallback + candidate/rejection context are preserved when present.
 *   - Missing router or QC evidence sets availability flags; no metric events
 *     are emitted for those categories.
 *   - Confidence: "high" when all expected source refs are available,
 *     "medium" when some are absent, "low" when most are absent.
 */

import type { SolEvidence } from "../types/sol-evidence.js";
import type {
  SolMetricEvent,
  SolProviderStartupFailureEvent,
  SolRouterFallbackEvent,
  SolWorkerExecutionFailureEvent,
  SolValidationFailureEvent,
  SolQcFindingEvent,
  SolInterventionEvent,
} from "../types/sol-metrics.js";
import type { SolSourceRef } from "../types/sol-scorecard.js";
import type { SolScoreConfidence } from "../types/sol-score.js";

// ──────────────────────────────────────────────
// Result type
// ──────────────────────────────────────────────

/**
 * The output of evidence normalization for one run.
 *
 * `events` is the flat list of typed metric events materialized from
 * the SolEvidence record. `source_refs` names every artifact that
 * contributed evidence (or was expected but absent).
 *
 * `evidence_confidence` reflects overall artifact availability:
 *   "high"   — run state, telemetry, and result packets all present
 *   "medium" — one or more expected artifact types missing
 *   "low"    — most artifact types missing
 *   "none"   — no artifacts present
 */
export interface SolEvidenceNormalizationResult {
  /** Run this normalization covers. */
  run_id: string;
  /** ISO 8601 timestamp of normalization. */
  normalized_at: string;
  /** Materialized metric events from evidence. */
  events: SolMetricEvent[];
  /** References to every artifact that contributed or was expected. */
  source_refs: SolSourceRef[];
  /** Overall confidence in the evidence. */
  evidence_confidence: SolScoreConfidence;
}

// ──────────────────────────────────────────────
// Internal helpers
// ──────────────────────────────────────────────

/** Artifact path context read from RunArtifacts paths. */
export interface EvidenceArtifactPaths {
  /** Path to the current-state.json (or null). */
  runStatePath: string | null;
  /** Path to the telemetry.jsonl (or null). */
  telemetryPath: string | null;
  /** Path to the cluster state JSON (or null). */
  clusterStatePath: string | null;
  /** Paths to result packets (worker sealed results). */
  resultPacketPaths: string[];
  /** Path to the QC directory (or null). */
  qcDir: string | null;
  /** Path to the run report .md (or null). */
  runReportPath: string | null;
}

function makeSourceRef(
  kind: string,
  path: string,
  available: boolean,
  unavailableReason?: string,
): SolSourceRef {
  return available
    ? { kind, path, available: true }
    : { kind, path, available: false, unavailable_reason: unavailableReason };
}

function computeConfidence(refs: SolSourceRef[]): SolScoreConfidence {
  if (refs.length === 0) return "none";
  const available = refs.filter((r) => r.available).length;
  const ratio = available / refs.length;
  if (ratio >= 0.8) return "high";
  if (ratio >= 0.4) return "medium";
  if (ratio > 0) return "low";
  return "none";
}

// ──────────────────────────────────────────────
// Source ref builders
// ──────────────────────────────────────────────

function buildSourceRefs(
  evidence: SolEvidence,
  paths: EvidenceArtifactPaths,
): SolSourceRef[] {
  const refs: SolSourceRef[] = [];

  // Run state
  if (paths.runStatePath) {
    refs.push(makeSourceRef("run-state", paths.runStatePath, evidence.run.status !== null));
  } else {
    refs.push(makeSourceRef("run-state", ".taskchain_artifacts/polaris-run/current-state.json", false, "path not resolved"));
  }

  // Telemetry
  if (paths.telemetryPath) {
    const hasTelemetry = evidence.tokens.total_worker_heartbeats > 0 || evidence.foreman.escalation_events > 0;
    refs.push(makeSourceRef("telemetry", paths.telemetryPath, hasTelemetry));
  } else {
    refs.push(makeSourceRef("telemetry", ".taskchain_artifacts/polaris-run/runs/<run-id>/telemetry.jsonl", false, "path not resolved"));
  }

  // Cluster state — available when the path was resolved (regardless of QC status)
  if (paths.clusterStatePath) {
    refs.push(makeSourceRef("cluster-state", paths.clusterStatePath, true));
  } else {
    refs.push(
      makeSourceRef(
        "cluster-state",
        `.polaris/clusters/${evidence.cluster_id ?? "unknown"}/cluster-state.json`,
        false,
        evidence.cluster_id ? "not found" : "cluster id not resolved",
      ),
    );
  }

  // Result packets (one per child with a known path)
  for (const child of evidence.children) {
    // Match filenames that are exactly "{child_id}.json" or start with "{child_id}-"
    // to handle commit-suffixed names (e.g. "POL-001-abc.json") while avoiding
    // false positives when IDs share a prefix (e.g. "1" vs "10").
    const packetPath = paths.resultPacketPaths.find((p) => {
      const filename = p.split('/').pop() ?? '';
      return filename === `${child.child_id}.json` || filename.startsWith(`${child.child_id}-`);
    });
    const path = packetPath ?? `.polaris/clusters/${evidence.cluster_id ?? "unknown"}/results/${child.child_id}.json`;
    refs.push(makeSourceRef("result-packet", path, packetPath !== undefined));
  }

  // QC artifacts
  if (evidence.qc.availability === "available") {
    refs.push(makeSourceRef("qc-finding", paths.qcDir ?? `.polaris/clusters/${evidence.cluster_id ?? "unknown"}/qc`, true));
  } else if (evidence.qc.availability === "future") {
    refs.push(makeSourceRef("qc-finding", `.polaris/clusters/${evidence.cluster_id ?? "unknown"}/qc`, false, "QC not yet run for this cluster"));
  }
  // "unavailable" (qc-disabled): no ref emitted

  // Run report
  if (paths.runReportPath) {
    refs.push(makeSourceRef("run-report", paths.runReportPath, true));
  } else {
    refs.push(makeSourceRef("run-report", `smartdocs/reports/sol/${evidence.run_id}-evaluation-report.md`, false, "path not resolved"));
  }

  return refs;
}

// ──────────────────────────────────────────────
// Metric event materializers
// ──────────────────────────────────────────────

function materializeProviderStartupFailures(evidence: SolEvidence): SolProviderStartupFailureEvent[] {
  if (evidence.router.availability !== "available") return [];

  return evidence.router.decisions
    .filter((d) => d.exhausted)
    .map((d): SolProviderStartupFailureEvent => ({
      category: "provider-startup-failure",
      run_id: evidence.run_id,
      child_id: d.child_id || undefined,
      provider: d.selected_provider ?? d.providers_tried[d.providers_tried.length - 1] ?? "unknown",
      failure_reason: d.exhausted_reason,
      providers_tried: d.providers_tried,
      all_providers_exhausted: d.exhausted,
    }));
}

function materializeRouterFallbacks(evidence: SolEvidence): SolRouterFallbackEvent[] {
  if (evidence.router.availability !== "available") return [];

  return evidence.router.decisions
    .filter((d) => d.fallback_used && !d.exhausted)
    .map((d): SolRouterFallbackEvent => {
      const originalProvider = d.providers_tried[0] ?? null;
      const fallbackProvider = d.selected_provider;
      // Child succeeded if it has a "done" completion (check worker evidence)
      const childResult = evidence.children.find((c) => c.child_id === d.child_id);
      const fallbackSucceeded = childResult?.status === "done";

      return {
        category: "router-fallback",
        run_id: evidence.run_id,
        child_id: d.child_id || undefined,
        original_provider: originalProvider,
        fallback_provider: fallbackProvider,
        providers_tried: d.providers_tried,
        fallback_succeeded: fallbackSucceeded ?? false,
        rejection_reasons: d.rejection_reasons,
      };
    });
}

function materializeWorkerExecutionFailures(evidence: SolEvidence): SolWorkerExecutionFailureEvent[] {
  // Worker execution failures: worker ran (not a startup failure) but status failed/error
  const exhaustedChildIds = new Set(
    evidence.router.availability === "available"
      ? evidence.router.decisions.filter((d) => d.exhausted).map((d) => d.child_id)
      : [],
  );

  return evidence.children
    .filter((c) => {
      // Must be a failed/error status (not "done" or "blocked")
      if (c.status !== "failed" && c.status !== "error") return false;
      // Exclude children where the provider never started (startup failure)
      if (exhaustedChildIds.has(c.child_id)) return false;
      return true;
    })
    .map((c): SolWorkerExecutionFailureEvent => {
      const validationRecord = evidence.validation.find((v) => v.child_id === c.child_id);
      return {
        category: "worker-execution-failure",
        run_id: evidence.run_id,
        child_id: c.child_id,
        worker_status: c.status,
        validation: validationRecord?.outcome ?? "unknown",
        provider: c.provider,
        error_message: validationRecord?.error_message ?? null,
        out_of_scope_escalation: evidence.intervention.out_of_scope_count > 0,
        escalation_count: c.escalation_count,
      };
    });
}

function materializeValidationFailures(evidence: SolEvidence): SolValidationFailureEvent[] {
  return evidence.validation
    .filter((v) => v.outcome === "failed")
    .map((v): SolValidationFailureEvent => {
      const childResult = evidence.children.find((c) => c.child_id === v.child_id);
      return {
        category: "validation-failure",
        run_id: evidence.run_id,
        child_id: v.child_id,
        worker_status: childResult?.status ?? "unknown",
        failed_commands: [],  // Commands not individually tracked in SolValidationEvidence
        passed_commands: v.passed_commands,
        error_message: v.error_message,
      };
    });
}

function materializeQcFindings(evidence: SolEvidence): SolQcFindingEvent[] {
  if (evidence.qc.availability !== "available") return [];

  const events: SolQcFindingEvent[] = [];

  // Blocking open findings by severity
  const severities = ["critical", "high", "medium", "low", "info"] as const;
  for (const sev of severities) {
    const count = evidence.qc.open_by_severity[sev];
    for (let i = 0; i < count; i++) {
      const isHighSeverity = sev === "critical" || sev === "high";
      events.push({
        category: "qc-finding",
        run_id: evidence.run_id,
        qc_provider: Object.keys(evidence.qc.provider_breakdown)[0] ?? "unknown",
        severity: sev,
        blocking: isHighSeverity && evidence.qc.blocks_delivery,
        autofixed: false,
        repaired: false,
        waived: false,
        unvalidated: false,
        summary: `Open ${sev} QC finding`,
        attribution_confidence: isHighSeverity ? "high" : "medium",
      });
    }
  }

  // Emit a single unvalidated aggregate event when unvalidated_findings > 0
  if (evidence.qc.unvalidated_findings > 0) {
    const noisyProvider = evidence.qc.noisy_providers[0] ?? "unknown";
    events.push({
      category: "qc-finding",
      run_id: evidence.run_id,
      qc_provider: noisyProvider,
      severity: "info",
      blocking: false,
      autofixed: false,
      repaired: false,
      waived: false,
      unvalidated: true,
      summary: `${evidence.qc.unvalidated_findings} unvalidated finding(s) from provider ${noisyProvider}`,
      attribution_confidence: "none",
    });
  }

  return events;
}

function materializeInterventions(evidence: SolEvidence): SolInterventionEvent[] {
  const events: SolInterventionEvent[] = [];

  if (evidence.intervention.user_intervened) {
    // Find the children that had user interventions for child_id attribution
    const intervened = evidence.children.filter((c) => c.user_intervened === true);
    if (intervened.length > 0) {
      for (const child of intervened) {
        events.push({
          category: "user-intervention",
          run_id: evidence.run_id,
          child_id: child.child_id,
          actor: "user",
          intervention_type: "commit",
          resolved: true,
        });
      }
    } else {
      events.push({
        category: "user-intervention",
        run_id: evidence.run_id,
        actor: "user",
        intervention_type: "unspecified",
        resolved: true,
      });
    }
  }

  if (evidence.intervention.foreman_intervened) {
    const intervened = evidence.children.filter((c) => c.foreman_intervened === true);
    if (intervened.length > 0) {
      for (const child of intervened) {
        events.push({
          category: "foreman-intervention",
          run_id: evidence.run_id,
          child_id: child.child_id,
          actor: "foreman",
          intervention_type: "commit",
          resolved: true,
        });
      }
    } else {
      events.push({
        category: "foreman-intervention",
        run_id: evidence.run_id,
        actor: "foreman",
        intervention_type: "unspecified",
        resolved: true,
      });
    }
  }

  if (evidence.intervention.state_repair_required) {
    events.push({
      category: "foreman-intervention",
      run_id: evidence.run_id,
      actor: "foreman",
      intervention_type: "state-repair",
      resolved: false,
    });
  }

  if (evidence.intervention.out_of_scope_count > 0) {
    events.push({
      category: "user-intervention",
      run_id: evidence.run_id,
      actor: "user",
      intervention_type: "out-of-scope",
      resolved: evidence.intervention.blocked_event_count > 0,
    });
  }

  return events;
}

// ──────────────────────────────────────────────
// Main entry point
// ──────────────────────────────────────────────

/**
 * Normalize a loaded SolEvidence record into raw metric events and source refs.
 *
 * Does not throw on missing data — absent optional fields mark source refs
 * as unavailable and reduce confidence. Missing router or QC inputs emit no
 * events for those categories.
 *
 * @param evidence — already-loaded SolEvidence (from aggregateSolEvidence)
 * @param paths    — artifact path context for source ref generation
 * @returns SolEvidenceNormalizationResult
 */
export function normalizeSolEvidence(
  evidence: SolEvidence,
  paths: EvidenceArtifactPaths = {
    runStatePath: null,
    telemetryPath: null,
    clusterStatePath: null,
    resultPacketPaths: [],
    qcDir: null,
    runReportPath: null,
  },
): SolEvidenceNormalizationResult {
  const source_refs = buildSourceRefs(evidence, paths);

  const events: SolMetricEvent[] = [
    ...materializeProviderStartupFailures(evidence),
    ...materializeRouterFallbacks(evidence),
    ...materializeWorkerExecutionFailures(evidence),
    ...materializeValidationFailures(evidence),
    ...materializeQcFindings(evidence),
    ...materializeInterventions(evidence),
  ];

  return {
    run_id: evidence.run_id,
    normalized_at: new Date().toISOString(),
    events,
    source_refs,
    evidence_confidence: computeConfidence(source_refs),
  };
}
