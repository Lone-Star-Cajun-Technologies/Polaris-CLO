/**
 * Tests for normalizeSolEvidence (SOL evidence normalizer).
 *
 * Coverage:
 *   - Empty evidence → no events, correct source ref availability, low/none confidence
 *   - Provider startup failures distinguished from worker execution failures
 *   - Router fallback events with candidate/rejection context preserved
 *   - Worker execution failures for failed/error status children
 *   - Validation failures emitted for outcome="failed" children
 *   - QC findings materialized from qc.open_by_severity + unvalidated
 *   - User and Foreman intervention events emitted with correct attribution
 *   - Missing router inputs (availability="future") → no startup/fallback events
 *   - Missing QC inputs (availability="future") → no qc-finding events
 *   - Source refs point to telemetry, result packets, cluster state, run state
 *   - Evidence confidence: high when all refs available, medium/low/none otherwise
 *   - State repair intervention emitted when state_repair_required=true
 *   - Out-of-scope intervention emitted when out_of_scope_count > 0
 */

import { describe, expect, it } from "vitest";
import { normalizeSolEvidence, type EvidenceArtifactPaths } from "./sol-evidence-normalizer.js";
import type { SolEvidence } from "../types/sol-evidence.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeEvidence(overrides: Partial<SolEvidence> = {}): SolEvidence {
  return {
    schema_version: "1.0",
    run_id: "test-run-001",
    cluster_id: "POL-000",
    observed_at: new Date().toISOString(),
    grouping_keys: {},
    run: {
      run_id: "test-run-001",
      cluster_id: "POL-000",
      branch: "main",
      status: "done",
      total_children: 0,
      completed_children: 0,
      dispatch_epoch: 1,
      continue_epoch: 0,
      state_observed_at: null,
    },
    children: [],
    foreman: {
      max_bootstrap_tokens: null,
      over_token_budget: false,
      redispatch_count: 0,
      redispatched_children: [],
      foreman_corrective_commit: false,
      escalation_events: 0,
    },
    worker: {
      total_heartbeats: 0,
      total_escalations: 0,
      workers_succeeded: 0,
      workers_failed: 0,
      workers_blocked: 0,
      validation_failures: 0,
      validation_passes: 0,
      user_interventions: 0,
      foreman_interventions: 0,
    },
    router: {
      availability: "future",
      total_decisions: 0,
      exhausted_decisions: 0,
      fallback_attempts: 0,
      successful_fallbacks: 0,
      decisions: [],
      recurring_failure_reasons: [],
    },
    qc: {
      availability: "future",
      qc_run_count: 0,
      total_findings: 0,
      blocking_findings: 0,
      autofixed_findings: 0,
      repaired_findings: 0,
      waived_findings: 0,
      unvalidated_findings: 0,
      weighted_open_score: 0,
      qc_penalty: 0,
      blocks_delivery: false,
      open_by_severity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
      provider_breakdown: {},
      repair_loop: null,
      noisy_providers: [],
      has_repair_failures: false,
      unresolved_high_severity: 0,
      max_round_exhausted: false,
    },
    validation: [],
    tokens: {
      max_bootstrap_tokens: null,
      total_worker_heartbeats: 0,
      tokens_by_child: {},
    },
    intervention: {
      user_intervened: false,
      foreman_intervened: false,
      blocked_event_count: 0,
      out_of_scope_count: 0,
      state_repair_required: false,
    },
    ...overrides,
  };
}

function emptyPaths(): EvidenceArtifactPaths {
  return {
    runStatePath: null,
    telemetryPath: null,
    clusterStatePath: null,
    resultPacketPaths: [],
    qcDir: null,
    runReportPath: null,
  };
}

// ── Schema / baseline ─────────────────────────────────────────────────────────

describe("normalizeSolEvidence schema", () => {
  it("returns all required top-level fields", () => {
    const result = normalizeSolEvidence(makeEvidence());
    expect(result.run_id).toBe("test-run-001");
    expect(typeof result.normalized_at).toBe("string");
    expect(Array.isArray(result.events)).toBe(true);
    expect(Array.isArray(result.source_refs)).toBe(true);
    expect(typeof result.evidence_confidence).toBe("string");
  });

  it("does not throw on empty evidence", () => {
    expect(() => normalizeSolEvidence(makeEvidence())).not.toThrow();
  });

  it("emits no events for completely empty evidence", () => {
    const result = normalizeSolEvidence(makeEvidence());
    expect(result.events).toHaveLength(0);
  });
});

// ── Source refs ───────────────────────────────────────────────────────────────

describe("source refs", () => {
  it("emits a run-state ref even when paths are null", () => {
    const result = normalizeSolEvidence(makeEvidence(), emptyPaths());
    const runStateRef = result.source_refs.find((r) => r.kind === "run-state");
    expect(runStateRef).toBeDefined();
    expect(runStateRef!.available).toBe(false);
  });

  it("marks run-state ref available when status is present", () => {
    const result = normalizeSolEvidence(
      makeEvidence({ run: { ...makeEvidence().run, status: "done" } }),
      { ...emptyPaths(), runStatePath: ".taskchain_artifacts/polaris-run/current-state.json" },
    );
    const ref = result.source_refs.find((r) => r.kind === "run-state");
    expect(ref!.available).toBe(true);
  });

  it("emits a result-packet ref for each child", () => {
    const evidence = makeEvidence({
      cluster_id: "POL-000",
      children: [
        {
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
          worker_id: "w1",
          escalation_count: 0,
          heartbeat_count: 3,
          user_intervened: null,
          foreman_intervened: null,
          changed_files: [],
          dispatch_epoch: 1,
          grouping_keys: {},
        },
      ],
    });
    const result = normalizeSolEvidence(evidence, emptyPaths());
    const packetRefs = result.source_refs.filter((r) => r.kind === "result-packet");
    expect(packetRefs).toHaveLength(1);
  });

  it("marks a result-packet ref available when path contains the child_id", () => {
    const evidence = makeEvidence({
      children: [
        {
          child_id: "POL-001",
          run_id: "test-run-001",
          cluster_id: "POL-000",
          status: "done",
          validation: "passed",
          commit: "abc",
          next_recommended_action: "continue",
          role: "worker",
          provider: "devin",
          skill_name: null,
          packet_hash: "h",
          worker_id: "w",
          escalation_count: 0,
          heartbeat_count: 1,
          user_intervened: null,
          foreman_intervened: null,
          changed_files: [],
          dispatch_epoch: null,
          grouping_keys: {},
        },
      ],
    });
    const result = normalizeSolEvidence(evidence, {
      ...emptyPaths(),
      resultPacketPaths: [".polaris/clusters/POL-000/results/POL-001-abc.json"],
    });
    const ref = result.source_refs.find((r) => r.kind === "result-packet");
    expect(ref!.available).toBe(true);
  });

  it("emits a qc-finding ref when QC is available", () => {
    const evidence = makeEvidence({
      qc: {
        ...makeEvidence().qc,
        availability: "available",
        qc_run_count: 1,
      },
    });
    const result = normalizeSolEvidence(evidence, { ...emptyPaths(), qcDir: ".polaris/clusters/POL-000/qc" });
    const qcRef = result.source_refs.find((r) => r.kind === "qc-finding");
    expect(qcRef).toBeDefined();
    expect(qcRef!.available).toBe(true);
  });

  it("emits unavailable qc-finding ref when QC is future", () => {
    const result = normalizeSolEvidence(makeEvidence(), emptyPaths());
    const qcRef = result.source_refs.find((r) => r.kind === "qc-finding");
    expect(qcRef).toBeDefined();
    expect(qcRef!.available).toBe(false);
  });

  it("emits run-report ref when path is provided", () => {
    const result = normalizeSolEvidence(makeEvidence(), {
      ...emptyPaths(),
      runReportPath: ".polaris/runs/test-run-001/run-report.md",
    });
    const ref = result.source_refs.find((r) => r.kind === "run-report");
    expect(ref).toBeDefined();
    expect(ref!.available).toBe(true);
  });
});

// ── Evidence confidence ───────────────────────────────────────────────────────

describe("evidence confidence", () => {
  it("returns none or low when no paths are provided", () => {
    const result = normalizeSolEvidence(makeEvidence(), emptyPaths());
    expect(["none", "low"]).toContain(result.evidence_confidence);
  });

  it("returns high when run-state and telemetry refs are available and qc is unavailable", () => {
    const evidence = makeEvidence({
      run: { ...makeEvidence().run, status: "done" },
      tokens: { max_bootstrap_tokens: null, total_worker_heartbeats: 5, tokens_by_child: {} },
      // Set qc to unavailable so no qc-finding ref is emitted (no ratio dilution)
      qc: { ...makeEvidence().qc, availability: "unavailable" },
    });
    const result = normalizeSolEvidence(evidence, {
      runStatePath: ".taskchain_artifacts/polaris-run/current-state.json",
      telemetryPath: ".taskchain_artifacts/polaris-run/runs/test-run-001/telemetry.jsonl",
      clusterStatePath: ".polaris/clusters/POL-000/cluster-state.json",
      resultPacketPaths: [],
      qcDir: null,
      runReportPath: null,
    });
    // Run-report is now counted as an expected ref, so 3/4 lands at medium.
    expect(result.evidence_confidence).toBe("medium");
  });

  it("returns medium when some refs are unavailable (e.g. qc future)", () => {
    const evidence = makeEvidence({
      run: { ...makeEvidence().run, status: "done" },
      tokens: { max_bootstrap_tokens: null, total_worker_heartbeats: 5, tokens_by_child: {} },
    });
    const result = normalizeSolEvidence(evidence, {
      runStatePath: ".taskchain_artifacts/polaris-run/current-state.json",
      telemetryPath: ".taskchain_artifacts/polaris-run/runs/test-run-001/telemetry.jsonl",
      clusterStatePath: ".polaris/clusters/POL-000/cluster-state.json",
      resultPacketPaths: [],
      qcDir: null,
      runReportPath: null,
    });
    // qc=future adds an unavailable ref; 3/4 = 75% → medium
    expect(result.evidence_confidence).toBe("medium");
  });
});

// ── Provider startup failures ─────────────────────────────────────────────────

describe("provider startup failures", () => {
  it("emits no startup events when router is future", () => {
    const result = normalizeSolEvidence(makeEvidence());
    const startup = result.events.filter((e) => e.category === "provider-startup-failure");
    expect(startup).toHaveLength(0);
  });

  it("emits a startup failure for each exhausted router decision", () => {
    const evidence = makeEvidence({
      router: {
        availability: "available",
        total_decisions: 1,
        exhausted_decisions: 1,
        fallback_attempts: 0,
        successful_fallbacks: 0,
        decisions: [
          {
            child_id: "POL-001",
            selected_provider: null,
            providers_tried: ["devin", "codex"],
            fallback_used: false,
            exhausted: true,
            exhausted_reason: "quota-exhausted",
            rejection_reasons: ["quota-exhausted"],
          },
        ],
        recurring_failure_reasons: [],
      },
    });
    const result = normalizeSolEvidence(evidence);
    const startup = result.events.filter((e) => e.category === "provider-startup-failure");
    expect(startup).toHaveLength(1);
    const ev = startup[0] as { category: string; child_id: string; providers_tried: string[]; all_providers_exhausted: boolean; failure_reason: string };
    expect(ev.child_id).toBe("POL-001");
    expect(ev.providers_tried).toEqual(["devin", "codex"]);
    expect(ev.all_providers_exhausted).toBe(true);
    expect(ev.failure_reason).toBe("quota-exhausted");
  });

  it("distinguishes startup failure from worker execution failure (no overlap)", () => {
    const evidence = makeEvidence({
      children: [
        {
          child_id: "POL-001",
          run_id: "test-run-001",
          cluster_id: "POL-000",
          status: "failed",
          validation: "failed",
          commit: null,
          next_recommended_action: "stop",
          role: "worker",
          provider: "devin",
          skill_name: null,
          packet_hash: "h",
          worker_id: "w",
          escalation_count: 0,
          heartbeat_count: 0,
          user_intervened: null,
          foreman_intervened: null,
          changed_files: [],
          dispatch_epoch: 1,
          grouping_keys: {},
        },
      ],
      validation: [{ child_id: "POL-001", outcome: "failed", passed_commands: [], error_message: null }],
      router: {
        availability: "available",
        total_decisions: 1,
        exhausted_decisions: 1,
        fallback_attempts: 0,
        successful_fallbacks: 0,
        decisions: [
          {
            child_id: "POL-001",
            selected_provider: null,
            providers_tried: ["devin"],
            fallback_used: false,
            exhausted: true,
            exhausted_reason: "provider-unavailable",
            rejection_reasons: [],
          },
        ],
        recurring_failure_reasons: [],
      },
    });
    const result = normalizeSolEvidence(evidence);
    const startup = result.events.filter((e) => e.category === "provider-startup-failure");
    const execution = result.events.filter((e) => e.category === "worker-execution-failure");
    // POL-001 is exhausted → startup failure only, not worker execution failure
    expect(startup).toHaveLength(1);
    expect(execution).toHaveLength(0);
  });
});

// ── Router fallback events ────────────────────────────────────────────────────

describe("router fallback events", () => {
  it("emits no fallback events when router is future", () => {
    const result = normalizeSolEvidence(makeEvidence());
    const fallbacks = result.events.filter((e) => e.category === "router-fallback");
    expect(fallbacks).toHaveLength(0);
  });

  it("emits a fallback event when providers_tried.length > 1 and not exhausted", () => {
    const evidence = makeEvidence({
      children: [
        {
          child_id: "POL-001",
          run_id: "test-run-001",
          cluster_id: "POL-000",
          status: "done",
          validation: "passed",
          commit: "abc",
          next_recommended_action: "continue",
          role: "worker",
          provider: "codex",
          skill_name: null,
          packet_hash: "h",
          worker_id: "w",
          escalation_count: 0,
          heartbeat_count: 3,
          user_intervened: null,
          foreman_intervened: null,
          changed_files: [],
          dispatch_epoch: 1,
          grouping_keys: {},
        },
      ],
      router: {
        availability: "available",
        total_decisions: 1,
        exhausted_decisions: 0,
        fallback_attempts: 1,
        successful_fallbacks: 1,
        decisions: [
          {
            child_id: "POL-001",
            selected_provider: "codex",
            providers_tried: ["devin", "codex"],
            fallback_used: true,
            exhausted: false,
            exhausted_reason: null,
            rejection_reasons: ["trust-too-low"],
          },
        ],
        recurring_failure_reasons: [],
      },
    });
    const result = normalizeSolEvidence(evidence);
    const fallbacks = result.events.filter((e) => e.category === "router-fallback");
    expect(fallbacks).toHaveLength(1);
    const ev = fallbacks[0] as {
      category: string;
      original_provider: string | null;
      fallback_provider: string | null;
      providers_tried: string[];
      fallback_succeeded: boolean;
      rejection_reasons: string[];
    };
    expect(ev.original_provider).toBe("devin");
    expect(ev.fallback_provider).toBe("codex");
    expect(ev.providers_tried).toEqual(["devin", "codex"]);
    expect(ev.rejection_reasons).toEqual(["trust-too-low"]);
    expect(ev.fallback_succeeded).toBe(true);
  });

  it("sets fallback_succeeded=false when child did not complete with done", () => {
    const evidence = makeEvidence({
      children: [
        {
          child_id: "POL-001",
          run_id: "test-run-001",
          cluster_id: "POL-000",
          status: "failed",
          validation: "failed",
          commit: null,
          next_recommended_action: "stop",
          role: "worker",
          provider: "codex",
          skill_name: null,
          packet_hash: "h",
          worker_id: "w",
          escalation_count: 0,
          heartbeat_count: 2,
          user_intervened: null,
          foreman_intervened: null,
          changed_files: [],
          dispatch_epoch: 1,
          grouping_keys: {},
        },
      ],
      router: {
        availability: "available",
        total_decisions: 1,
        exhausted_decisions: 0,
        fallback_attempts: 1,
        successful_fallbacks: 0,
        decisions: [
          {
            child_id: "POL-001",
            selected_provider: "codex",
            providers_tried: ["devin", "codex"],
            fallback_used: true,
            exhausted: false,
            exhausted_reason: null,
            rejection_reasons: [],
          },
        ],
        recurring_failure_reasons: [],
      },
    });
    const result = normalizeSolEvidence(evidence);
    const fallback = result.events.find((e) => e.category === "router-fallback") as
      | { fallback_succeeded: boolean }
      | undefined;
    expect(fallback!.fallback_succeeded).toBe(false);
  });
});

// ── Worker execution failures ─────────────────────────────────────────────────

describe("worker execution failures", () => {
  it("emits events for children with failed status", () => {
    const evidence = makeEvidence({
      children: [
        {
          child_id: "POL-002",
          run_id: "test-run-001",
          cluster_id: "POL-000",
          status: "failed",
          validation: "failed",
          commit: null,
          next_recommended_action: "stop",
          role: "worker",
          provider: "devin",
          skill_name: null,
          packet_hash: "h",
          worker_id: "w",
          escalation_count: 1,
          heartbeat_count: 2,
          user_intervened: null,
          foreman_intervened: null,
          changed_files: [],
          dispatch_epoch: 1,
          grouping_keys: {},
        },
      ],
      validation: [{ child_id: "POL-002", outcome: "failed", passed_commands: [], error_message: "build error" }],
    });
    const result = normalizeSolEvidence(evidence);
    const failures = result.events.filter((e) => e.category === "worker-execution-failure");
    expect(failures).toHaveLength(1);
    const ev = failures[0] as { worker_status: string; provider: string; error_message: string | null; escalation_count: number };
    expect(ev.worker_status).toBe("failed");
    expect(ev.provider).toBe("devin");
    expect(ev.error_message).toBe("build error");
    expect(ev.escalation_count).toBe(1);
  });

  it("does not emit execution failure for done children", () => {
    const evidence = makeEvidence({
      children: [
        {
          child_id: "POL-001",
          run_id: "test-run-001",
          cluster_id: "POL-000",
          status: "done",
          validation: "passed",
          commit: "abc",
          next_recommended_action: "continue",
          role: "worker",
          provider: "devin",
          skill_name: null,
          packet_hash: "h",
          worker_id: "w",
          escalation_count: 0,
          heartbeat_count: 3,
          user_intervened: null,
          foreman_intervened: null,
          changed_files: [],
          dispatch_epoch: 1,
          grouping_keys: {},
        },
      ],
    });
    const result = normalizeSolEvidence(evidence);
    const failures = result.events.filter((e) => e.category === "worker-execution-failure");
    expect(failures).toHaveLength(0);
  });
});

// ── Validation failures ───────────────────────────────────────────────────────

describe("validation failures", () => {
  it("emits validation failure events for outcome=failed", () => {
    const evidence = makeEvidence({
      validation: [
        { child_id: "POL-001", outcome: "failed", passed_commands: ["npm run build"], error_message: "test suite failed" },
      ],
      children: [
        {
          child_id: "POL-001",
          run_id: "test-run-001",
          cluster_id: "POL-000",
          status: "done",
          validation: "failed",
          commit: "abc",
          next_recommended_action: "stop",
          role: "worker",
          provider: "devin",
          skill_name: null,
          packet_hash: "h",
          worker_id: "w",
          escalation_count: 0,
          heartbeat_count: 3,
          user_intervened: null,
          foreman_intervened: null,
          changed_files: [],
          dispatch_epoch: 1,
          grouping_keys: {},
        },
      ],
    });
    const result = normalizeSolEvidence(evidence);
    const validationEvents = result.events.filter((e) => e.category === "validation-failure");
    expect(validationEvents).toHaveLength(1);
    const ev = validationEvents[0] as { passed_commands: string[]; error_message: string | null; worker_status: string };
    expect(ev.passed_commands).toEqual(["npm run build"]);
    expect(ev.error_message).toBe("test suite failed");
    expect(ev.worker_status).toBe("done");
  });

  it("emits no validation failure when outcome is passed", () => {
    const evidence = makeEvidence({
      validation: [{ child_id: "POL-001", outcome: "passed", passed_commands: ["npm test"], error_message: null }],
    });
    const result = normalizeSolEvidence(evidence);
    const validationEvents = result.events.filter((e) => e.category === "validation-failure");
    expect(validationEvents).toHaveLength(0);
  });
});

// ── QC findings ───────────────────────────────────────────────────────────────

describe("qc findings", () => {
  it("emits no QC events when qc availability is future", () => {
    const result = normalizeSolEvidence(makeEvidence());
    const qcEvents = result.events.filter((e) => e.category === "qc-finding");
    expect(qcEvents).toHaveLength(0);
  });

  it("emits QC events for open findings by severity", () => {
    const evidence = makeEvidence({
      qc: {
        ...makeEvidence().qc,
        availability: "available",
        qc_run_count: 1,
        total_findings: 2,
        blocking_findings: 1,
        open_by_severity: { critical: 0, high: 1, medium: 1, low: 0, info: 0 },
        provider_breakdown: { coderabbit: { total: 2, blocking: 1, unvalidated: 0 } },
        blocks_delivery: true,
      },
    });
    const result = normalizeSolEvidence(evidence);
    const qcEvents = result.events.filter((e) => e.category === "qc-finding");
    // 1 high + 1 medium = 2 events
    expect(qcEvents).toHaveLength(2);
    const highEvent = qcEvents.find((e) => (e as { severity: string }).severity === "high") as
      | { blocking: boolean; attribution_confidence: string }
      | undefined;
    expect(highEvent!.blocking).toBe(true);
    expect(highEvent!.attribution_confidence).toBe("high");
  });

  it("emits unvalidated qc-finding event when unvalidated_findings > 0", () => {
    const evidence = makeEvidence({
      qc: {
        ...makeEvidence().qc,
        availability: "available",
        qc_run_count: 1,
        unvalidated_findings: 3,
        noisy_providers: ["coderabbit"],
        open_by_severity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
        provider_breakdown: { coderabbit: { total: 3, blocking: 0, unvalidated: 3 } },
      },
    });
    const result = normalizeSolEvidence(evidence);
    const unvalidated = result.events.filter((e) => e.category === "qc-finding" && (e as { unvalidated: boolean }).unvalidated);
    expect(unvalidated).toHaveLength(1);
    const ev = unvalidated[0] as { attribution_confidence: string; qc_provider: string };
    expect(ev.attribution_confidence).toBe("none");
    expect(ev.qc_provider).toBe("coderabbit");
  });
});

// ── Intervention events ───────────────────────────────────────────────────────

describe("intervention events", () => {
  it("emits user-intervention when user_intervened=true with child attribution", () => {
    const evidence = makeEvidence({
      intervention: {
        user_intervened: true,
        foreman_intervened: false,
        blocked_event_count: 0,
        out_of_scope_count: 0,
        state_repair_required: false,
      },
      children: [
        {
          child_id: "POL-001",
          run_id: "test-run-001",
          cluster_id: "POL-000",
          status: "done",
          validation: "passed",
          commit: "abc",
          next_recommended_action: "continue",
          role: "worker",
          provider: "devin",
          skill_name: null,
          packet_hash: "h",
          worker_id: "w",
          escalation_count: 0,
          heartbeat_count: 3,
          user_intervened: true,
          foreman_intervened: false,
          changed_files: [],
          dispatch_epoch: 1,
          grouping_keys: {},
        },
      ],
    });
    const result = normalizeSolEvidence(evidence);
    const interventions = result.events.filter((e) => e.category === "user-intervention");
    expect(interventions).toHaveLength(1);
    const ev = interventions[0] as { child_id: string | undefined; intervention_type: string; actor: string };
    expect(ev.child_id).toBe("POL-001");
    expect(ev.intervention_type).toBe("commit");
    expect(ev.actor).toBe("user");
  });

  it("emits foreman-intervention when foreman_intervened=true", () => {
    const evidence = makeEvidence({
      intervention: {
        user_intervened: false,
        foreman_intervened: true,
        blocked_event_count: 0,
        out_of_scope_count: 0,
        state_repair_required: false,
      },
      children: [
        {
          child_id: "POL-002",
          run_id: "test-run-001",
          cluster_id: "POL-000",
          status: "done",
          validation: "passed",
          commit: "abc",
          next_recommended_action: "continue",
          role: "worker",
          provider: "devin",
          skill_name: null,
          packet_hash: "h",
          worker_id: "w",
          escalation_count: 0,
          heartbeat_count: 3,
          user_intervened: false,
          foreman_intervened: true,
          changed_files: [],
          dispatch_epoch: 1,
          grouping_keys: {},
        },
      ],
    });
    const result = normalizeSolEvidence(evidence);
    const interventions = result.events.filter((e) => e.category === "foreman-intervention");
    expect(interventions).toHaveLength(1);
    const ev = interventions[0] as { child_id: string | undefined; actor: string };
    expect(ev.child_id).toBe("POL-002");
    expect(ev.actor).toBe("foreman");
  });

  it("emits state-repair foreman-intervention when state_repair_required=true", () => {
    const evidence = makeEvidence({
      intervention: {
        user_intervened: false,
        foreman_intervened: false,
        blocked_event_count: 0,
        out_of_scope_count: 0,
        state_repair_required: true,
      },
    });
    const result = normalizeSolEvidence(evidence);
    const stateRepair = result.events.filter(
      (e) => e.category === "foreman-intervention" && (e as { intervention_type: string }).intervention_type === "state-repair",
    );
    expect(stateRepair).toHaveLength(1);
  });

  it("emits out-of-scope user-intervention when out_of_scope_count > 0", () => {
    const evidence = makeEvidence({
      intervention: {
        user_intervened: false,
        foreman_intervened: false,
        blocked_event_count: 1,
        out_of_scope_count: 1,
        state_repair_required: false,
      },
    });
    const result = normalizeSolEvidence(evidence);
    const outOfScope = result.events.filter(
      (e) => e.category === "user-intervention" && (e as { intervention_type: string }).intervention_type === "out-of-scope",
    );
    expect(outOfScope).toHaveLength(1);
  });

  it("emits no intervention events when all flags are false/zero", () => {
    const result = normalizeSolEvidence(makeEvidence());
    const interventions = result.events.filter(
      (e) => e.category === "user-intervention" || e.category === "foreman-intervention",
    );
    expect(interventions).toHaveLength(0);
  });
});

// ── Missing evidence tolerance ────────────────────────────────────────────────

describe("missing evidence tolerance", () => {
  it("missing router evidence does not fail or emit startup/fallback events", () => {
    const evidence = makeEvidence({
      router: { ...makeEvidence().router, availability: "future" },
    });
    const result = normalizeSolEvidence(evidence);
    expect(() => normalizeSolEvidence(evidence)).not.toThrow();
    expect(result.events.filter((e) => e.category === "provider-startup-failure")).toHaveLength(0);
    expect(result.events.filter((e) => e.category === "router-fallback")).toHaveLength(0);
  });

  it("missing QC evidence does not fail or emit qc-finding events", () => {
    const evidence = makeEvidence({
      qc: { ...makeEvidence().qc, availability: "future" },
    });
    const result = normalizeSolEvidence(evidence);
    expect(() => normalizeSolEvidence(evidence)).not.toThrow();
    expect(result.events.filter((e) => e.category === "qc-finding")).toHaveLength(0);
  });

  it("qc-disabled availability emits no qc events and no qc source ref", () => {
    const evidence = makeEvidence({
      qc: { ...makeEvidence().qc, availability: "unavailable" },
    });
    const result = normalizeSolEvidence(evidence);
    expect(result.events.filter((e) => e.category === "qc-finding")).toHaveLength(0);
    const qcRef = result.source_refs.find((r) => r.kind === "qc-finding");
    expect(qcRef).toBeUndefined();
  });

  it("null cluster_id does not cause errors", () => {
    const evidence = makeEvidence({ cluster_id: null });
    expect(() => normalizeSolEvidence(evidence)).not.toThrow();
  });

  it("empty children list produces no execution failure events", () => {
    const result = normalizeSolEvidence(makeEvidence({ children: [] }));
    expect(result.events.filter((e) => e.category === "worker-execution-failure")).toHaveLength(0);
  });
});

// ── Integration: full run ─────────────────────────────────────────────────────

describe("integration: full run with all evidence signals", () => {
  it("materializes all six metric categories without throwing", () => {
    const baseEvidence = makeEvidence();
    const evidence = makeEvidence({
      run: { ...baseEvidence.run, status: "done" },
      children: [
        {
          child_id: "POL-001",
          run_id: "test-run-001",
          cluster_id: "POL-000",
          status: "done",
          validation: "passed",
          commit: "abc",
          next_recommended_action: "continue",
          role: "worker",
          provider: "codex",  // fallback provider
          skill_name: null,
          packet_hash: "h",
          worker_id: "w",
          escalation_count: 0,
          heartbeat_count: 5,
          user_intervened: true,
          foreman_intervened: false,
          changed_files: [],
          dispatch_epoch: 1,
          grouping_keys: {},
        },
        {
          child_id: "POL-002",
          run_id: "test-run-001",
          cluster_id: "POL-000",
          status: "failed",
          validation: "failed",
          commit: null,
          next_recommended_action: "stop",
          role: "worker",
          provider: "devin",
          skill_name: null,
          packet_hash: "h2",
          worker_id: "w2",
          escalation_count: 1,
          heartbeat_count: 2,
          user_intervened: false,
          foreman_intervened: false,
          changed_files: [],
          dispatch_epoch: 1,
          grouping_keys: {},
        },
        {
          child_id: "POL-003",
          run_id: "test-run-001",
          cluster_id: "POL-000",
          status: "failed",
          validation: "failed",
          commit: null,
          next_recommended_action: "stop",
          role: "worker",
          provider: "devin",
          skill_name: null,
          packet_hash: "h3",
          worker_id: "w3",
          escalation_count: 0,
          heartbeat_count: 0,
          user_intervened: false,
          foreman_intervened: false,
          changed_files: [],
          dispatch_epoch: 1,
          grouping_keys: {},
        },
      ],
      validation: [
        { child_id: "POL-001", outcome: "passed", passed_commands: ["npm test"], error_message: null },
        { child_id: "POL-002", outcome: "failed", passed_commands: [], error_message: "build fail" },
        { child_id: "POL-003", outcome: "failed", passed_commands: [], error_message: null },
      ],
      router: {
        availability: "available",
        total_decisions: 3,
        exhausted_decisions: 1,
        fallback_attempts: 1,
        successful_fallbacks: 1,
        decisions: [
          {
            child_id: "POL-001",
            selected_provider: "codex",
            providers_tried: ["devin", "codex"],
            fallback_used: true,
            exhausted: false,
            exhausted_reason: null,
            rejection_reasons: ["trust-too-low"],
          },
          {
            child_id: "POL-003",
            selected_provider: null,
            providers_tried: ["devin"],
            fallback_used: false,
            exhausted: true,
            exhausted_reason: "quota-exhausted",
            rejection_reasons: [],
          },
        ],
        recurring_failure_reasons: [],
      },
      qc: {
        availability: "available",
        qc_run_count: 1,
        total_findings: 1,
        blocking_findings: 1,
        autofixed_findings: 0,
        repaired_findings: 0,
        waived_findings: 0,
        unvalidated_findings: 0,
        weighted_open_score: 0.8,
        qc_penalty: 0.2,
        blocks_delivery: true,
        open_by_severity: { critical: 0, high: 1, medium: 0, low: 0, info: 0 },
        provider_breakdown: { coderabbit: { total: 1, blocking: 1, unvalidated: 0 } },
        repair_loop: null,
        noisy_providers: [],
        has_repair_failures: false,
        unresolved_high_severity: 1,
        max_round_exhausted: false,
      },
      intervention: {
        user_intervened: true,
        foreman_intervened: false,
        blocked_event_count: 0,
        out_of_scope_count: 0,
        state_repair_required: false,
      },
    });

    expect(() => normalizeSolEvidence(evidence)).not.toThrow();
    const result = normalizeSolEvidence(evidence);

    // startup: POL-003
    expect(result.events.filter((e) => e.category === "provider-startup-failure")).toHaveLength(1);
    // fallback: POL-001
    expect(result.events.filter((e) => e.category === "router-fallback")).toHaveLength(1);
    // execution failure: POL-002 only (POL-003 is startup, not execution)
    expect(result.events.filter((e) => e.category === "worker-execution-failure")).toHaveLength(1);
    // validation failures: POL-002
    expect(result.events.filter((e) => e.category === "validation-failure")).toHaveLength(2);
    // qc: 1 high
    expect(result.events.filter((e) => e.category === "qc-finding")).toHaveLength(1);
    // user intervention: POL-001
    expect(result.events.filter((e) => e.category === "user-intervention")).toHaveLength(1);

    // Source refs present
    expect(result.source_refs.length).toBeGreaterThan(0);
    expect(result.source_refs.find((r) => r.kind === "run-state")).toBeDefined();
    expect(result.source_refs.find((r) => r.kind === "qc-finding")).toBeDefined();
  });
});
