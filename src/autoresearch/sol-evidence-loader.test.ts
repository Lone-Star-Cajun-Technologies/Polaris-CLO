/**
 * Tests for aggregateSolEvidence (SOL evidence loader).
 *
 * Coverage:
 *   - Legacy autoresearch runs (no completed_children_results, no telemetry)
 *   - Runs with completed_children_results
 *   - Missing telemetry → router marked "future"
 *   - Missing QC results → qc marked "future"
 *   - Future optional QC/router evidence tolerated without throwing
 *   - Schema validation (required fields, types)
 *   - Grouping key propagation from child contracts
 *   - Foreman evidence: bootstrap tokens, re-dispatch, corrective commit
 *   - Worker aggregate: counts, validation, interventions
 *   - Intervention evidence: user, foreman, blocked, out-of-scope, medic
 *   - Token evidence: heartbeat aggregation, per-child tokens
 *   - Router evidence: available / future / exhausted paths
 *   - QC evidence: available / future paths
 */

import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { aggregateSolEvidence } from "./sol-evidence-loader.js";
import type { RunArtifacts } from "./score.js";
import type { WorkerResultContract } from "../types/result-packet.js";
import type { QcResult } from "../qc/types.js";
import type { ClusterState } from "../cluster-state/types.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function emptyArtifacts(overrides: Partial<RunArtifacts> = {}): RunArtifacts {
  return {
    runId: "test-run-001",
    runDir: null,
    clusterDir: null,
    currentState: null,
    ledgerEvents: [],
    resultPackets: [],
    workerResultContracts: [],
    telemetryEvents: [],
    qcResults: [],
    clusterState: null,
    ...overrides,
  };
}

function makeContract(overrides: Partial<WorkerResultContract> = {}): WorkerResultContract {
  return {
    child_id: "POL-001",
    run_id: "test-run-001",
    cluster_id: "POL-000",
    status: "done",
    validation: "passed",
    commit: "abc123",
    next_recommended_action: "continue",
    role: "worker",
    provider: "devin",
    skill_name: "polaris-run",
    packet_hash: "hash1",
    worker_id: "worker-001",
    escalation_count: 0,
    heartbeat_count: 3,
    result_artifact_path: "/fake/path",
    packet_path: "/fake/packet",
    telemetry_path: "/fake/telemetry",
    user_intervened: null,
    foreman_intervened: null,
    ...overrides,
  };
}

function makeQcResult(overrides: Partial<QcResult> & { findings?: QcResult["findings"] } = {}): QcResult {
  return {
    schemaVersion: "1.0",
    qcRunId: `qc-run-${Date.now()}`,
    runId: "test-run-001",
    clusterId: "POL-000",
    trigger: "completed-cluster",
    provider: "coderabbit",
    providerMode: "local",
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    status: "findings",
    findings: [],
    rawArtifactPaths: [],
    parserVersion: "1.0",
    policyDecision: {
      blocksDelivery: false,
      requiresOperatorReview: false,
      routedToRepair: false,
      summary: "test",
    },
    ...overrides,
  };
}

// ── Schema validation ─────────────────────────────────────────────────────────

describe("aggregateSolEvidence schema", () => {
  it("returns a SolEvidence with all required top-level fields", () => {
    const ev = aggregateSolEvidence(emptyArtifacts());

    expect(ev.schema_version).toBe("1.0");
    expect(typeof ev.run_id).toBe("string");
    expect(typeof ev.observed_at).toBe("string");
    expect(typeof ev.grouping_keys).toBe("object");
    expect(typeof ev.run).toBe("object");
    expect(Array.isArray(ev.children)).toBe(true);
    expect(typeof ev.foreman).toBe("object");
    expect(typeof ev.worker).toBe("object");
    expect(typeof ev.router).toBe("object");
    expect(typeof ev.qc).toBe("object");
    expect(Array.isArray(ev.validation)).toBe(true);
    expect(typeof ev.tokens).toBe("object");
    expect(typeof ev.intervention).toBe("object");
  });

  it("sets cluster_id from current state", () => {
    const ev = aggregateSolEvidence(
      emptyArtifacts({ currentState: { run_id: "test-run-001", cluster_id: "POL-000" } }),
    );
    expect(ev.cluster_id).toBe("POL-000");
  });

  it("sets cluster_id to null when state is absent", () => {
    const ev = aggregateSolEvidence(emptyArtifacts());
    expect(ev.cluster_id).toBeNull();
  });
});

// ── Legacy autoresearch runs ──────────────────────────────────────────────────

describe("legacy autoresearch run (no completed_children_results, no telemetry)", () => {
  it("returns empty children and marks router/qc as future", () => {
    const ev = aggregateSolEvidence(emptyArtifacts());
    expect(ev.children).toHaveLength(0);
    expect(ev.router.availability).toBe("future");
    expect(ev.qc.availability).toBe("future");
  });

  it("does not throw when runDir and clusterDir are null", () => {
    expect(() => aggregateSolEvidence(emptyArtifacts())).not.toThrow();
  });

  it("worker aggregate returns all-zero counts for no contracts", () => {
    const ev = aggregateSolEvidence(emptyArtifacts());
    expect(ev.worker.workers_succeeded).toBe(0);
    expect(ev.worker.workers_failed).toBe(0);
    expect(ev.worker.total_heartbeats).toBe(0);
  });
});

// ── Runs with completed_children_results ─────────────────────────────────────

describe("runs with completed_children_results", () => {
  it("maps WorkerResultContract fields into SolChildEvidence", () => {
    const contract = makeContract({
      child_id: "POL-001",
      status: "done",
      validation: "passed",
      commit: "abc123",
      role: "worker",
      provider: "devin",
      heartbeat_count: 5,
      escalation_count: 1,
      user_intervened: false,
      foreman_intervened: false,
      changed_files: ["src/foo.ts"],
    });
    const ev = aggregateSolEvidence(emptyArtifacts({ workerResultContracts: [contract] }));
    expect(ev.children).toHaveLength(1);
    const child = ev.children[0]!;
    expect(child.child_id).toBe("POL-001");
    expect(child.status).toBe("done");
    expect(child.validation).toBe("passed");
    expect(child.commit).toBe("abc123");
    expect(child.role).toBe("worker");
    expect(child.provider).toBe("devin");
    expect(child.heartbeat_count).toBe(5);
    expect(child.escalation_count).toBe(1);
    expect(child.user_intervened).toBe(false);
    expect(child.foreman_intervened).toBe(false);
    expect(child.changed_files).toEqual(["src/foo.ts"]);
  });

  it("propagates grouping keys from contract role/provider", () => {
    const contract = makeContract({ role: "worker", provider: "codex" });
    const ev = aggregateSolEvidence(emptyArtifacts({ workerResultContracts: [contract] }));
    const keys = ev.children[0]!.grouping_keys;
    expect(keys.role).toBe("worker");
    expect(keys.provider).toBe("codex");
  });

  it("aggregates worker counts correctly", () => {
    const contracts = [
      makeContract({ child_id: "POL-001", status: "done", validation: "passed", heartbeat_count: 3, escalation_count: 0, user_intervened: false, foreman_intervened: false }),
      makeContract({ child_id: "POL-002", status: "failed", validation: "failed", heartbeat_count: 2, escalation_count: 1, user_intervened: true, foreman_intervened: false }),
      makeContract({ child_id: "POL-003", status: "blocked", validation: "skipped", heartbeat_count: 1, escalation_count: 0, user_intervened: false, foreman_intervened: true }),
    ];
    const ev = aggregateSolEvidence(emptyArtifacts({ workerResultContracts: contracts }));
    const w = ev.worker;
    expect(w.workers_succeeded).toBe(1);
    expect(w.workers_failed).toBe(1);
    expect(w.workers_blocked).toBe(1);
    expect(w.total_heartbeats).toBe(6);
    expect(w.total_escalations).toBe(1);
    expect(w.validation_passes).toBe(1);
    expect(w.validation_failures).toBe(1);
    expect(w.user_interventions).toBe(1);
    expect(w.foreman_interventions).toBe(1);
  });

  it("validates: maps outcome per child", () => {
    const contract = makeContract({ child_id: "POL-001", validation: "passed" });
    const ev = aggregateSolEvidence(emptyArtifacts({ workerResultContracts: [contract] }));
    expect(ev.validation).toHaveLength(1);
    expect(ev.validation[0]!.child_id).toBe("POL-001");
    expect(ev.validation[0]!.outcome).toBe("passed");
  });
});

// ── Missing telemetry ─────────────────────────────────────────────────────────

describe("missing telemetry", () => {
  it("marks router as future when no provider-selected / provider-exhausted events", () => {
    const ev = aggregateSolEvidence(emptyArtifacts({ telemetryEvents: [] }));
    expect(ev.router.availability).toBe("future");
    expect(ev.router.total_decisions).toBe(0);
    expect(ev.router.decisions).toHaveLength(0);
  });

  it("marks router as available when provider-selected events are present", () => {
    const ev = aggregateSolEvidence(
      emptyArtifacts({
        telemetryEvents: [
          {
            event: "provider-selected",
            child_id: "POL-001",
            selected_provider: "devin",
            providers_tried: ["devin"],
          },
        ],
      }),
    );
    expect(ev.router.availability).toBe("available");
    expect(ev.router.total_decisions).toBe(1);
  });

  it("marks router as available with exhausted decisions", () => {
    const ev = aggregateSolEvidence(
      emptyArtifacts({
        telemetryEvents: [
          {
            event: "provider-exhausted",
            child_id: "POL-001",
            reason: "quota-exhausted",
          },
        ],
      }),
    );
    expect(ev.router.availability).toBe("available");
    expect(ev.router.exhausted_decisions).toBe(1);
  });

  it("tokens: max_bootstrap_tokens is null when no size events", () => {
    const ev = aggregateSolEvidence(emptyArtifacts({ telemetryEvents: [] }));
    expect(ev.tokens.max_bootstrap_tokens).toBeNull();
  });

  it("foreman: over_token_budget is false when no size events", () => {
    const ev = aggregateSolEvidence(emptyArtifacts({ telemetryEvents: [] }));
    expect(ev.foreman.over_token_budget).toBe(false);
  });
});

// ── Foreman evidence ──────────────────────────────────────────────────────────

describe("foreman evidence", () => {
  it("detects over-budget bootstrap token burn", () => {
    const ev = aggregateSolEvidence(
      emptyArtifacts({
        telemetryEvents: [
          { event: "bootstrap-context-size", combined_estimated_tokens: 200_000 },
        ],
      }),
    );
    expect(ev.foreman.max_bootstrap_tokens).toBe(200_000);
    expect(ev.foreman.over_token_budget).toBe(true);
  });

  it("stays under budget below 150k", () => {
    const ev = aggregateSolEvidence(
      emptyArtifacts({
        telemetryEvents: [
          { event: "bootstrap-context-size", combined_estimated_tokens: 50_000 },
        ],
      }),
    );
    expect(ev.foreman.over_token_budget).toBe(false);
  });

  it("detects re-dispatched children from ledger", () => {
    const ev = aggregateSolEvidence(
      emptyArtifacts({
        currentState: { dispatch_boundary: { dispatch_epoch: 2 } },
        ledgerEvents: [
          { event: "child-dispatched", issue_id: "POL-001" },
          { event: "child-dispatched", issue_id: "POL-001" },
          { event: "child-dispatched", issue_id: "POL-002" },
        ],
      }),
    );
    expect(ev.foreman.redispatch_count).toBe(1);
    expect(ev.foreman.redispatched_children).toContain("POL-001");
    expect(ev.foreman.redispatched_children).not.toContain("POL-002");
  });

  it("detects foreman corrective commit from contract foreman_intervened", () => {
    const contract = makeContract({ foreman_intervened: true });
    const ev = aggregateSolEvidence(emptyArtifacts({ workerResultContracts: [contract] }));
    expect(ev.foreman.foreman_corrective_commit).toBe(true);
  });

  it("no corrective commit when foreman_intervened is false", () => {
    const contract = makeContract({ foreman_intervened: false });
    const ev = aggregateSolEvidence(emptyArtifacts({ workerResultContracts: [contract] }));
    expect(ev.foreman.foreman_corrective_commit).toBe(false);
  });

  it("counts escalation-initiated events", () => {
    const ev = aggregateSolEvidence(
      emptyArtifacts({
        telemetryEvents: [
          { event: "escalation-initiated", reason: "no-provider" },
          { event: "escalation-initiated", reason: "no-provider" },
        ],
      }),
    );
    expect(ev.foreman.escalation_events).toBe(2);
  });
});

// ── Intervention evidence ─────────────────────────────────────────────────────

describe("intervention evidence", () => {
  it("sets user_intervened=true when any contract has it", () => {
    const contracts = [
      makeContract({ child_id: "POL-001", user_intervened: true }),
      makeContract({ child_id: "POL-002", user_intervened: false }),
    ];
    const ev = aggregateSolEvidence(emptyArtifacts({ workerResultContracts: contracts }));
    expect(ev.intervention.user_intervened).toBe(true);
  });

  it("sets foreman_intervened=true when any contract has it", () => {
    const contract = makeContract({ foreman_intervened: true });
    const ev = aggregateSolEvidence(emptyArtifacts({ workerResultContracts: [contract] }));
    expect(ev.intervention.foreman_intervened).toBe(true);
  });

  it("counts worker-blocked events", () => {
    const ev = aggregateSolEvidence(
      emptyArtifacts({
        telemetryEvents: [
          { event: "worker-blocked", approval_type: "destructive" },
          { event: "worker-blocked", approval_type: "out-of-scope" },
        ],
      }),
    );
    expect(ev.intervention.blocked_event_count).toBe(2);
    expect(ev.intervention.out_of_scope_count).toBe(1);
  });

  it("detects state_repair_required from CHART- file in cluster dir", () => {
    const dir = join(tmpdir(), `sol-ev-medic-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "CHART-001-abc.json"), JSON.stringify({ status: "partial" }));
    const ev = aggregateSolEvidence(emptyArtifacts({ clusterDir: dir }));
    expect(ev.intervention.state_repair_required).toBe(true);
  });

  it("state_repair_required is false when cluster dir has no medic artifacts", () => {
    const dir = join(tmpdir(), `sol-ev-clean-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "cluster-state.json"), JSON.stringify({ schema_version: "1.0" }));
    const ev = aggregateSolEvidence(emptyArtifacts({ clusterDir: dir }));
    expect(ev.intervention.state_repair_required).toBe(false);
  });

  it("state_repair_required is false when clusterDir is null", () => {
    const ev = aggregateSolEvidence(emptyArtifacts());
    expect(ev.intervention.state_repair_required).toBe(false);
  });
});

// ── Token evidence ────────────────────────────────────────────────────────────

describe("token evidence", () => {
  it("aggregates max bootstrap tokens across multiple events", () => {
    const ev = aggregateSolEvidence(
      emptyArtifacts({
        telemetryEvents: [
          { event: "bootstrap-context-size", combined_estimated_tokens: 40_000 },
          { event: "bootstrap-context-size", combined_estimated_tokens: 80_000 },
          { event: "bootstrap-context-size", combined_estimated_tokens: 60_000 },
        ],
      }),
    );
    expect(ev.tokens.max_bootstrap_tokens).toBe(80_000);
  });

  it("counts total_worker_heartbeats", () => {
    const ev = aggregateSolEvidence(
      emptyArtifacts({
        telemetryEvents: [
          { event: "worker-heartbeat", child_id: "POL-001", step_cursor: "start" },
          { event: "worker-heartbeat", child_id: "POL-001", step_cursor: "implement" },
          { event: "worker-heartbeat", child_id: "POL-002", step_cursor: "start" },
          { event: "other-event", child_id: "POL-001" },
        ],
      }),
    );
    expect(ev.tokens.total_worker_heartbeats).toBe(3);
  });

  it("aggregates tokens_by_child from heartbeat tokens_used", () => {
    const ev = aggregateSolEvidence(
      emptyArtifacts({
        telemetryEvents: [
          { event: "worker-heartbeat", child_id: "POL-001", tokens_used: 1000 },
          { event: "worker-heartbeat", child_id: "POL-001", tokens_used: 500 },
          { event: "worker-heartbeat", child_id: "POL-002", tokens_used: 2000 },
        ],
      }),
    );
    expect(ev.tokens.tokens_by_child["POL-001"]).toBe(1500);
    expect(ev.tokens.tokens_by_child["POL-002"]).toBe(2000);
  });

  it("ignores heartbeats without tokens_used", () => {
    const ev = aggregateSolEvidence(
      emptyArtifacts({
        telemetryEvents: [
          { event: "worker-heartbeat", child_id: "POL-001", step_cursor: "start" },
        ],
      }),
    );
    expect(ev.tokens.tokens_by_child).toEqual({});
  });
});

// ── Router evidence ───────────────────────────────────────────────────────────

describe("router evidence", () => {
  it("marks future when no router events", () => {
    const ev = aggregateSolEvidence(emptyArtifacts());
    expect(ev.router.availability).toBe("future");
  });

  it("builds decision record from provider-selected event", () => {
    const ev = aggregateSolEvidence(
      emptyArtifacts({
        telemetryEvents: [
          {
            event: "provider-selected",
            child_id: "POL-001",
            selected_provider: "devin",
            providers_tried: ["devin"],
            router_exhausted_reason: null,
            router_candidates: [],
          },
        ],
      }),
    );
    expect(ev.router.decisions).toHaveLength(1);
    const d = ev.router.decisions[0]!;
    expect(d.child_id).toBe("POL-001");
    expect(d.selected_provider).toBe("devin");
    expect(d.fallback_used).toBe(false);
    expect(d.exhausted).toBe(false);
  });

  it("detects fallback_used when providers_tried.length > 1", () => {
    const ev = aggregateSolEvidence(
      emptyArtifacts({
        telemetryEvents: [
          {
            event: "provider-selected",
            child_id: "POL-001",
            selected_provider: "codex",
            providers_tried: ["devin", "codex"],
          },
        ],
      }),
    );
    expect(ev.router.decisions[0]!.fallback_used).toBe(true);
  });

  it("marks exhausted when selected_provider is null", () => {
    const ev = aggregateSolEvidence(
      emptyArtifacts({
        telemetryEvents: [
          {
            event: "provider-selected",
            child_id: "POL-001",
            selected_provider: null,
            router_exhausted_reason: "quota-exhausted",
            router_candidates: [
              { provider: "devin", eligible: false, rejection_reasons: ["quota-exhausted"] },
            ],
          },
        ],
      }),
    );
    expect(ev.router.decisions[0]!.exhausted).toBe(true);
    expect(ev.router.decisions[0]!.exhausted_reason).toBe("quota-exhausted");
  });

  it("builds recurring_failure_reasons from exhausted decisions", () => {
    const ev = aggregateSolEvidence(
      emptyArtifacts({
        telemetryEvents: [
          { event: "provider-exhausted", child_id: "POL-001", reason: "trust-too-low" },
          { event: "provider-exhausted", child_id: "POL-002", reason: "trust-too-low" },
        ],
      }),
    );
    expect(ev.router.recurring_failure_reasons).toHaveLength(1);
    expect(ev.router.recurring_failure_reasons[0]!.reason).toBe("trust-too-low");
    expect(ev.router.recurring_failure_reasons[0]!.occurrences).toBe(2);
  });
});

// ── QC evidence ───────────────────────────────────────────────────────────────

describe("qc evidence", () => {
  it("marks future when no QC results", () => {
    const ev = aggregateSolEvidence(emptyArtifacts());
    expect(ev.qc.availability).toBe("future");
    expect(ev.qc.qc_run_count).toBe(0);
    expect(ev.qc.total_findings).toBe(0);
  });

  it("marks available and aggregates when QC results exist", () => {
    const findings: QcResult["findings"] = [
      {
        findingId: "f1",
        severity: "high",
        title: "Open high",
        fixAvailable: false,
        autofixEligible: false,
        attribution: { confidence: "high", reason: "commit-line-match" },
        status: "open",
      },
    ];
    const ev = aggregateSolEvidence(
      emptyArtifacts({ qcResults: [makeQcResult({ findings })] }),
    );
    expect(ev.qc.availability).toBe("available");
    expect(ev.qc.qc_run_count).toBe(1);
    expect(ev.qc.total_findings).toBe(1);
    expect(ev.qc.blocking_findings).toBe(1);
    expect(ev.qc.open_by_severity.high).toBe(1);
  });

  it("surfaces blocks_delivery from QC policy", () => {
    const ev = aggregateSolEvidence(
      emptyArtifacts({
        qcResults: [
          makeQcResult({
            policyDecision: {
              blocksDelivery: true,
              requiresOperatorReview: false,
              routedToRepair: false,
              summary: "blocked",
            },
          }),
        ],
      }),
    );
    expect(ev.qc.blocks_delivery).toBe(true);
  });
});

function makeClusterState(overrides: Partial<ClusterState> = {}): ClusterState {
  return {
    schema_version: "1.0",
    cluster_id: "POL-000",
    state_generation: 1,
    child_states: [],
    claim_metadata: {},
    packet_pointers: {},
    result_pointers: {},
    validation_results: {},
    commits: {},
    tracker_mutations: {},
    blockers: [],
    qc_runs: {},
    ...overrides,
  } as ClusterState;
}

// ── QC repair-loop evidence ──────────────────────────────────────────────────

describe("qc repair loop evidence", () => {
  it("marks no QC configured when clusterState reports qc-disabled", () => {
    const ev = aggregateSolEvidence(
      emptyArtifacts({
        clusterState: makeClusterState({ qc_repair_outcome: "qc-disabled" }),
      }),
    );
    expect(ev.qc.availability).toBe("unavailable");
    expect(ev.qc.repair_loop?.status).toBe("not-configured");
  });

  it("marks QC ran with no findings as not-run when no repair loop telemetry", () => {
    const ev = aggregateSolEvidence(
      emptyArtifacts({ qcResults: [makeQcResult({ findings: [] })] }),
    );
    expect(ev.qc.availability).toBe("available");
    expect(ev.qc.repair_loop?.status).toBe("not-run");
    expect(ev.qc.total_findings).toBe(0);
  });

  it("surfaces provider failure via allProvidersFailed", () => {
    const ev = aggregateSolEvidence(
      emptyArtifacts({
        qcResults: [makeQcResult({ allProvidersFailed: true, status: "failed" })],
      }),
    );
    expect(ev.qc.repair_loop?.provider_attempts.all_providers_failed).toBe(true);
    expect(ev.qc.repair_loop?.provider_attempts.failure).toBe(1);
  });

  it("surfaces repair success from terminal telemetry", () => {
    const ev = aggregateSolEvidence(
      emptyArtifacts({
        qcResults: [makeQcResult()],
        telemetryEvents: [
          { event: "qc-repair-manifest-compiled", packet_count: 1 },
          { event: "qc-repair-rerun-complete", action: "pass" },
          { event: "qc-repair-loop-terminal", outcome: "pass", rounds_completed: 1, max_rounds: 2 },
        ],
      }),
    );
    expect(ev.qc.repair_loop?.status).toBe("passed");
    expect(ev.qc.repair_loop?.rounds_completed).toBe(1);
    expect(ev.qc.repair_loop?.packets_compiled).toBe(1);
    expect(ev.qc.repair_loop?.rerun_outcome).toBe("pass");
  });

  it("surfaces max-rounds exhaustion", () => {
    const ev = aggregateSolEvidence(
      emptyArtifacts({
        qcResults: [makeQcResult()],
        telemetryEvents: [
          { event: "qc-repair-manifest-compiled", packet_count: 2 },
          { event: "qc-repair-loop-terminal", outcome: "max-rounds", rounds_completed: 2, max_rounds: 2 },
        ],
      }),
    );
    expect(ev.qc.repair_loop?.status).toBe("max-rounds");
    expect(ev.qc.max_round_exhausted).toBe(true);
  });

  it("surfaces medic referral", () => {
    const ev = aggregateSolEvidence(
      emptyArtifacts({
        qcResults: [makeQcResult()],
        telemetryEvents: [
          { event: "qc-repair-manifest-compiled", packet_count: 1 },
          { event: "qc-repair-worker-failures", failed_packet_ids: ["pkt-1"] },
          { event: "qc-repair-loop-terminal", outcome: "medic-referral", rounds_completed: 1, max_rounds: 2 },
        ],
      }),
    );
    expect(ev.qc.repair_loop?.status).toBe("medic-referral");
    expect(ev.qc.has_repair_failures).toBe(true);
  });

  it("maps provider breakdown", () => {
    const findings: QcResult["findings"] = [
      {
        findingId: "f1",
        severity: "high",
        title: "Open high",
        fixAvailable: false,
        autofixEligible: false,
        attribution: { confidence: "high", reason: "commit-line-match" },
        status: "open",
      },
    ];
    const ev = aggregateSolEvidence(
      emptyArtifacts({ qcResults: [makeQcResult({ provider: "coderabbit", findings })] }),
    );
    expect(ev.qc.provider_breakdown["coderabbit"]!.total).toBe(1);
    expect(ev.qc.provider_breakdown["coderabbit"]!.blocking).toBe(1);
  });
});

// ── Run evidence ──────────────────────────────────────────────────────────────

describe("run evidence", () => {
  it("extracts run fields from current state", () => {
    const ev = aggregateSolEvidence(
      emptyArtifacts({
        currentState: {
          run_id: "test-run-001",
          cluster_id: "POL-000",
          branch: "pol-477-delivery",
          status: "running",
          open_children: ["POL-002"],
          completed_children: ["POL-001"],
          dispatch_boundary: { dispatch_epoch: 2, continue_epoch: 1 },
        },
      }),
    );
    const r = ev.run;
    expect(r.run_id).toBe("test-run-001");
    expect(r.cluster_id).toBe("POL-000");
    expect(r.branch).toBe("pol-477-delivery");
    expect(r.status).toBe("running");
    expect(r.total_children).toBe(2);
    expect(r.completed_children).toBe(1);
    expect(r.dispatch_epoch).toBe(2);
    expect(r.continue_epoch).toBe(1);
  });

  it("returns null for absent fields when state is null", () => {
    const ev = aggregateSolEvidence(emptyArtifacts());
    const r = ev.run;
    expect(r.cluster_id).toBeNull();
    expect(r.branch).toBeNull();
    expect(r.status).toBeNull();
    expect(r.total_children).toBe(0);
    expect(r.dispatch_epoch).toBeNull();
  });
});

// ── Integration: full run with all evidence ───────────────────────────────────

describe("integration: full run with completed children and telemetry", () => {
  it("produces a complete SolEvidence without throwing", () => {
    const contracts = [
      makeContract({
        child_id: "POL-001",
        status: "done",
        validation: "passed",
        heartbeat_count: 5,
        user_intervened: false,
        foreman_intervened: false,
      }),
      makeContract({
        child_id: "POL-002",
        status: "done",
        validation: "passed",
        heartbeat_count: 4,
        user_intervened: false,
        foreman_intervened: false,
      }),
    ];

    const telemetryEvents = [
      { event: "bootstrap-context-size", combined_estimated_tokens: 55_000 },
      { event: "worker-heartbeat", child_id: "POL-001", step_cursor: "start", tokens_used: 1000 },
      { event: "worker-heartbeat", child_id: "POL-001", step_cursor: "implement", tokens_used: 2000 },
      { event: "provider-selected", child_id: "POL-001", selected_provider: "devin", providers_tried: ["devin"] },
      { event: "provider-selected", child_id: "POL-002", selected_provider: "devin", providers_tried: ["devin"] },
      { event: "child-complete", child_id: "POL-001", completion_status: "done" },
      { event: "child-complete", child_id: "POL-002", completion_status: "done" },
    ];

    const ev = aggregateSolEvidence(
      emptyArtifacts({
        currentState: {
          run_id: "test-run-001",
          cluster_id: "POL-000",
          branch: "feature-branch",
          status: "done",
          open_children: [],
          completed_children: ["POL-001", "POL-002"],
          dispatch_boundary: { dispatch_epoch: 2, continue_epoch: 1 },
        },
        workerResultContracts: contracts,
        telemetryEvents,
        qcResults: [makeQcResult()],
      }),
    );

    expect(ev.schema_version).toBe("1.0");
    expect(ev.children).toHaveLength(2);
    expect(ev.worker.workers_succeeded).toBe(2);
    expect(ev.worker.validation_passes).toBe(2);
    expect(ev.foreman.max_bootstrap_tokens).toBe(55_000);
    expect(ev.foreman.over_token_budget).toBe(false);
    expect(ev.router.availability).toBe("available");
    expect(ev.router.total_decisions).toBe(2);
    expect(ev.qc.availability).toBe("available");
    expect(ev.tokens.max_bootstrap_tokens).toBe(55_000);
    expect(ev.tokens.tokens_by_child["POL-001"]).toBe(3000);
  });
});
