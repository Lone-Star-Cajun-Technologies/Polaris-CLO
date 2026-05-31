import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CurrentState } from "../../../src/types/runtime-state.js";

vi.mock("../../../src/runtime/state.js");
vi.mock("../../../src/runtime/audit/logger.js");

import * as stateModule from "../../../src/runtime/state.js";
import * as auditModule from "../../../src/runtime/audit/logger.js";
import { executeDryRun } from "../../../src/runtime/continuation/dry-run.js";

const runningState: CurrentState = {
  schema_version: "1.0",
  run_id: "polaris-run-test",
  cluster_id: "POL-80",
  active_child: null,
  completed_children: [],
  open_children: ["POL-82", "POL-81"],
  step_cursor: "06-decide-continuation",
  context_budget: { children_completed: 0, max_children_per_session: 3 },
  status: "running",
  runtime_generation: 1,
  orchestration_mode: "bootstrap",
  continuation_epoch: 0,
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(auditModule.appendAuditEvent).mockResolvedValue(undefined);
});

describe("executeDryRun", () => {
  it("returns ok preview for an eligible run", async () => {
    vi.mocked(stateModule.loadState).mockResolvedValue(runningState);
    const result = await executeDryRun({
      artifact_dir: "polaris-run",
      expected_step_cursor: "06-decide-continuation",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.preview.next_child).toBe("POL-81");
    expect(result.preview.approval_template.run_id).toBe("polaris-run-test");
    expect(result.preview.approval_template.requested_action).toBe("loop_continue");
    expect(result.preview.approval_template.nonce).toBeTruthy();
    expect(result.preview.fingerprint).toBe(result.preview.approval_template.fingerprint);
  });

  it("does not include bootstrap packets, worktrees, or worker details", async () => {
    vi.mocked(stateModule.loadState).mockResolvedValue(runningState);
    const result = await executeDryRun({
      artifact_dir: "polaris-run",
      expected_step_cursor: "06-decide-continuation",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const preview = result.preview as Record<string, unknown>;
    expect(preview).not.toHaveProperty("bootstrap_packet_preview");
    expect(preview).not.toHaveProperty("estimated_actions");
    expect(preview).not.toHaveProperty("worker_type");
    expect(preview).not.toHaveProperty("provider");
  });

  it("generates a unique nonce per call", async () => {
    vi.mocked(stateModule.loadState).mockResolvedValue(runningState);
    const [a, b] = await Promise.all([
      executeDryRun({ artifact_dir: "polaris-run", expected_step_cursor: "06-decide-continuation" }),
      executeDryRun({ artifact_dir: "polaris-run", expected_step_cursor: "06-decide-continuation" }),
    ]);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.preview.approval_template.nonce).not.toBe(b.preview.approval_template.nonce);
  });

  it("rejects when run is not found", async () => {
    vi.mocked(stateModule.loadState).mockResolvedValue(null);
    const result = await executeDryRun({ artifact_dir: "missing", expected_step_cursor: "06-decide-continuation" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejection.reason).toBe("run_not_found");
  });

  it("rejects when run is not in running state", async () => {
    vi.mocked(stateModule.loadState).mockResolvedValue({ ...runningState, status: "stopped" });
    const result = await executeDryRun({ artifact_dir: "polaris-run", expected_step_cursor: "06-decide-continuation" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejection.reason).toBe("run_not_continuable");
  });

  it("rejects when active_child is set", async () => {
    vi.mocked(stateModule.loadState).mockResolvedValue({ ...runningState, active_child: "POL-81" });
    const result = await executeDryRun({ artifact_dir: "polaris-run", expected_step_cursor: "06-decide-continuation" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejection.reason).toBe("concurrent_execution");
  });

  it("rejects step_cursor mismatch", async () => {
    vi.mocked(stateModule.loadState).mockResolvedValue(runningState);
    const result = await executeDryRun({ artifact_dir: "polaris-run", expected_step_cursor: "03-execute-child" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.rejection.reason).toBe("step_cursor_mismatch");
      expect(result.rejection.actual).toBe("06-decide-continuation");
    }
  });

  it("rejects when no open children remain", async () => {
    vi.mocked(stateModule.loadState).mockResolvedValue({ ...runningState, open_children: [] });
    const result = await executeDryRun({ artifact_dir: "polaris-run", expected_step_cursor: "06-decide-continuation" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejection.reason).toBe("no_open_children");
  });

  it("logs a dry_run_executed audit event on success", async () => {
    vi.mocked(stateModule.loadState).mockResolvedValue(runningState);
    await executeDryRun({ artifact_dir: "polaris-run", expected_step_cursor: "06-decide-continuation" });
    expect(auditModule.appendAuditEvent).toHaveBeenCalledWith(
      "polaris-run",
      expect.objectContaining({ event_type: "dry_run_executed", result: "preview" })
    );
  });

  it("does not log an audit event on rejection", async () => {
    vi.mocked(stateModule.loadState).mockResolvedValue(null);
    await executeDryRun({ artifact_dir: "missing", expected_step_cursor: "06-decide-continuation" });
    expect(auditModule.appendAuditEvent).not.toHaveBeenCalled();
  });
});
