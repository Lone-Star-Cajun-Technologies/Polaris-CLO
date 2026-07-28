import { describe, expect, it } from "vitest";
import { buildCompactBootstrapState, buildExecutionAdapterContract, selectExecutionAdapter } from "./execution-adapter.js";

describe("selectExecutionAdapter", () => {
  it("prefers native same-agent subtask dispatch inside interactive agent sessions", () => {
    const selected = selectExecutionAdapter({
      insideAgentSession: true,
      nativeSubtaskAvailable: true,
    });

    expect(selected.mode).toBe("agent-subtask");
    expect(selected.autoDispatch).toBe(true);
    expect(selected.providerCoupling).toBe("native-same-agent");
  });

  it("does not cross-call another agent unless explicitly configured", () => {
    const selected = selectExecutionAdapter({
      insideAgentSession: true,
      nativeSubtaskAvailable: false,
      configuredAdapter: "cross-agent",
      crossAgentConfigured: false,
      tokenBudgetLow: false,
    });

    expect(selected.mode).toBe("terminal-cli");
    expect(selected.autoDispatch).toBe(false);
    expect(selected.warnings).toContain("cross-agent fallback requires explicit configuration or low-token emergency");
  });

  it("allows explicit cross-agent fallback when configured", () => {
    const selected = selectExecutionAdapter({
      insideAgentSession: true,
      nativeSubtaskAvailable: false,
      configuredAdapter: "cross-agent",
      crossAgentConfigured: true,
    });

    expect(selected.mode).toBe("cross-agent");
    expect(selected.autoDispatch).toBe(true);
  });
});

describe("buildCompactBootstrapState", () => {
  it("contains only compact handoff fields", () => {
    const compact = buildCompactBootstrapState({
      runId: "run-001",
      clusterId: "POL-42",
      childId: "POL-49",
      stateFile: ".taskchain_artifacts/polaris-run/current-state.json",
      telemetryFile: ".taskchain_artifacts/polaris-run/runs/run-001/telemetry.jsonl",
      currentStateSha: "abc123",
      branch: "feature/pol-42",
    });

    expect(compact).toEqual({
      run_id: "run-001",
      cluster_id: "POL-42",
      child_id: "POL-49",
      state_file: ".taskchain_artifacts/polaris-run/current-state.json",
      telemetry_file: ".taskchain_artifacts/polaris-run/runs/run-001/telemetry.jsonl",
      current_state_sha: "abc123",
      branch: "feature/pol-42",
      compact_mode: "standard",
      return_summary_contract: [
        "child_id",
        "status",
        "commit_hash",
        "validation_summary",
        "next_action",
      ],
    });
  });

  it("defaults compact_mode to 'standard' when not provided", () => {
    const compact = buildCompactBootstrapState({
      runId: "run-001",
      clusterId: "POL-42",
      childId: null,
      stateFile: "state.json",
      telemetryFile: "telemetry.jsonl",
      currentStateSha: "abc123",
      branch: "main",
    });

    expect(compact.compact_mode).toBe("standard");
  });

  it("uses provided compactMode when specified", () => {
    const compact = buildCompactBootstrapState({
      runId: "run-001",
      clusterId: "POL-42",
      childId: "POL-49",
      stateFile: "state.json",
      telemetryFile: "telemetry.jsonl",
      currentStateSha: "abc123",
      branch: "main",
      compactMode: "strict",
    });

    expect(compact.compact_mode).toBe("strict");
  });

  it("passes through 'minimal' compact_mode", () => {
    const compact = buildCompactBootstrapState({
      runId: "run-001",
      clusterId: "POL-42",
      childId: "POL-49",
      stateFile: "state.json",
      telemetryFile: "telemetry.jsonl",
      currentStateSha: "abc123",
      branch: "main",
      compactMode: "minimal",
    });

    expect(compact.compact_mode).toBe("minimal");
  });

  it("compact_mode matches the config value for all three levels", () => {
    const levels = ["standard", "strict", "minimal"] as const;
    for (const level of levels) {
      const compact = buildCompactBootstrapState({
        runId: "run-001",
        clusterId: "POL-42",
        childId: "POL-49",
        stateFile: "state.json",
        telemetryFile: "telemetry.jsonl",
        currentStateSha: "abc123",
        branch: "main",
        compactMode: level,
      });
      expect(compact.compact_mode).toBe(level);
    }
  });

  it("compact_mode is 'standard' when compactMode is omitted (default)", () => {
    const compact = buildCompactBootstrapState({
      runId: "run-002",
      clusterId: "POL-50",
      childId: "POL-51",
      stateFile: "state.json",
      telemetryFile: "telemetry.jsonl",
      currentStateSha: "def456",
      branch: "main",
      // compactMode intentionally omitted
    });
    expect(compact.compact_mode).toBe("standard");
  });

  it("includes all required CompactBootstrapState fields", () => {
    const compact = buildCompactBootstrapState({
      runId: "run-003",
      clusterId: "POL-60",
      childId: "POL-61",
      stateFile: "state.json",
      telemetryFile: "telemetry.jsonl",
      currentStateSha: "ghi789",
      branch: "feature/pol-60",
      compactMode: "strict",
    });

    expect(compact.run_id).toBe("run-003");
    expect(compact.cluster_id).toBe("POL-60");
    expect(compact.child_id).toBe("POL-61");
    expect(compact.state_file).toBe("state.json");
    expect(compact.telemetry_file).toBe("telemetry.jsonl");
    expect(compact.current_state_sha).toBe("ghi789");
    expect(compact.branch).toBe("feature/pol-60");
    expect(compact.compact_mode).toBe("strict");
    expect(Array.isArray(compact.return_summary_contract)).toBe(true);
  });
});

describe("selectExecutionAdapter — paperclip", () => {
  it("selects paperclip when explicitly configured", () => {
    const selected = selectExecutionAdapter({
      explicitAdapter: "paperclip",
      paperclipConfigured: true,
    });

    expect(selected.mode).toBe("paperclip");
    expect(selected.autoDispatch).toBe(true);
    expect(selected.providerCoupling).toBe("control-plane");
    expect(selected.priority).toBe(2);
    expect(selected.reason).toBe("control-plane provider coupling configured for Paperclip adapter");
  });

  it("selects paperclip via configuredAdapter when no explicitAdapter is provided", () => {
    const selected = selectExecutionAdapter({
      configuredAdapter: "paperclip",
    });

    expect(selected.mode).toBe("paperclip");
    expect(selected.autoDispatch).toBe(true);
    expect(selected.providerCoupling).toBe("control-plane");
  });

  it("prefers explicitAdapter over configuredAdapter when both are provided", () => {
    const selected = selectExecutionAdapter({
      explicitAdapter: "paperclip",
      configuredAdapter: "terminal-cli",
    });

    expect(selected.mode).toBe("paperclip");
  });

  it("selects paperclip even when paperclipConfigured is false or omitted", () => {
    const selectedFalse = selectExecutionAdapter({
      explicitAdapter: "paperclip",
      paperclipConfigured: false,
    });
    const selectedOmitted = selectExecutionAdapter({
      explicitAdapter: "paperclip",
    });

    expect(selectedFalse.mode).toBe("paperclip");
    expect(selectedFalse.autoDispatch).toBe(true);
    expect(selectedOmitted.mode).toBe("paperclip");
    expect(selectedOmitted.autoDispatch).toBe(true);
  });

  it("returns no warnings for a directly configured paperclip adapter", () => {
    const selected = selectExecutionAdapter({
      explicitAdapter: "paperclip",
    });

    expect(selected.warnings).toEqual([]);
  });
});

describe("buildExecutionAdapterContract — paperclip", () => {
  it("includes paperclip as the last entry in the fallback order", () => {
    const selection = selectExecutionAdapter({ explicitAdapter: "paperclip" });
    const compact = buildCompactBootstrapState({
      runId: "run-010",
      clusterId: "POL-70",
      childId: "POL-71",
      stateFile: "state.json",
      telemetryFile: "telemetry.jsonl",
      currentStateSha: "sha1",
      branch: "main",
    });

    const contract = buildExecutionAdapterContract(selection, compact);

    expect(contract.fallback_order).toContain("paperclip");
    expect(contract.fallback_order[contract.fallback_order.length - 1]).toBe("paperclip");
  });

  it("builds a full contract carrying the paperclip selection and dispatch contract invariants", () => {
    const selection = selectExecutionAdapter({ explicitAdapter: "paperclip" });
    const compact = buildCompactBootstrapState({
      runId: "run-011",
      clusterId: "POL-72",
      childId: "POL-73",
      stateFile: "state.json",
      telemetryFile: "telemetry.jsonl",
      currentStateSha: "sha2",
      branch: "main",
    });

    const contract = buildExecutionAdapterContract(selection, compact);

    expect(contract.mode).toBe("paperclip");
    expect(contract.providerCoupling).toBe("control-plane");
    expect(contract.compact_bootstrap_state).toEqual(compact);
    expect(contract.dispatch_contract).toEqual({
      one_child_per_worker: true,
      parent_receives_compact_summary_only: true,
      child_transcript_retained_by_worker: true,
      updates_current_state_and_telemetry: true,
    });
  });
});