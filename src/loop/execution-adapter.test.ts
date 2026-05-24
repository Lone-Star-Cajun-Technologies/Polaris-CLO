import { describe, expect, it } from "vitest";
import { buildCompactBootstrapState, selectExecutionAdapter } from "./execution-adapter.js";

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
      return_summary_contract: [
        "child_id",
        "status",
        "commit_hash",
        "validation_summary",
        "next_action",
      ],
    });
  });
});
