import { describe, it, expect } from "vitest";
import {
  computeStateFingerprint,
  selectNextChild,
  verifyApprovalEnvelope,
} from "../../src/loop/verify.js";
import type { CurrentState } from "../../src/types/runtime-state.js";

const baseState: CurrentState = {
  schema_version: "1.0",
  run_id: "polaris-run-test",
  cluster_id: "POL-80",
  active_child: null,
  completed_children: [],
  open_children: ["POL-82", "POL-81", "POL-83"],
  step_cursor: "06-decide-continuation",
  context_budget: { children_completed: 0, max_children_per_session: 3 },
  status: "running",
};

describe("computeStateFingerprint", () => {
  it("produces consistent output for the same state", () => {
    expect(computeStateFingerprint(baseState)).toBe(computeStateFingerprint(baseState));
  });

  it("is order-independent for open_children", () => {
    const shuffled: CurrentState = {
      ...baseState,
      open_children: ["POL-83", "POL-81", "POL-82"],
    };
    expect(computeStateFingerprint(baseState)).toBe(computeStateFingerprint(shuffled));
  });

  it("changes when run_id changes", () => {
    const different: CurrentState = { ...baseState, run_id: "other-run" };
    expect(computeStateFingerprint(baseState)).not.toBe(computeStateFingerprint(different));
  });

  it("changes when step_cursor changes", () => {
    const different: CurrentState = { ...baseState, step_cursor: "03-execute-child" };
    expect(computeStateFingerprint(baseState)).not.toBe(computeStateFingerprint(different));
  });
});

describe("selectNextChild", () => {
  it("returns lowest-sorted open child", () => {
    expect(selectNextChild(baseState)).toBe("POL-81");
  });

  it("returns null when no open children", () => {
    expect(selectNextChild({ ...baseState, open_children: [] })).toBeNull();
  });

  it("is order-independent", () => {
    const shuffled: CurrentState = {
      ...baseState,
      open_children: ["POL-83", "POL-81", "POL-82"],
    };
    expect(selectNextChild(shuffled)).toBe("POL-81");
  });
});

describe("verifyApprovalEnvelope", () => {
  const fingerprint = computeStateFingerprint(baseState);
  const validEnvelope = {
    run_id: "polaris-run-test",
    expected_step_cursor: "06-decide-continuation",
    expected_next_child: "POL-81",
    state_fingerprint: fingerprint,
    approved_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
  };

  it("returns ok for a valid envelope", () => {
    const result = verifyApprovalEnvelope(baseState, validEnvelope);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.next_child).toBe("POL-81");
  });

  it("rejects when run is not in running state", () => {
    const result = verifyApprovalEnvelope(
      { ...baseState, status: "stopped" },
      validEnvelope
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.reason).toBe("run_not_continuable");
  });

  it("rejects when active_child is set", () => {
    const result = verifyApprovalEnvelope(
      { ...baseState, active_child: "POL-81" },
      validEnvelope
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.reason).toBe("concurrent_execution");
  });

  it("rejects mismatched run_id", () => {
    const result = verifyApprovalEnvelope(baseState, {
      ...validEnvelope,
      run_id: "wrong-run",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.reason).toBe("run_id_mismatch");
  });

  it("rejects stale step cursor", () => {
    const result = verifyApprovalEnvelope(baseState, {
      ...validEnvelope,
      expected_step_cursor: "03-execute-child",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.reason).toBe("step_cursor_mismatch");
  });

  it("rejects when state has mutated since approval (fingerprint mismatch)", () => {
    const result = verifyApprovalEnvelope(
      { ...baseState, open_children: ["POL-81", "POL-82"] },
      validEnvelope
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.reason).toBe("state_mutated_since_approval");
  });

  it("rejects mismatched expected_next_child", () => {
    const fp = computeStateFingerprint(baseState);
    const result = verifyApprovalEnvelope(baseState, {
      ...validEnvelope,
      expected_next_child: "POL-99",
      state_fingerprint: fp,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.reason).toBe("next_child_mismatch");
  });

  it("rejects expired approvals", () => {
    const result = verifyApprovalEnvelope(baseState, {
      ...validEnvelope,
      expires_at: new Date(Date.now() - 1000).toISOString(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.reason).toBe("approval_expired");
  });

  it("rejects when there are no open children", () => {
    const emptyState: CurrentState = { ...baseState, open_children: [] };
    const fp = computeStateFingerprint(emptyState);
    const result = verifyApprovalEnvelope(emptyState, {
      ...validEnvelope,
      state_fingerprint: fp,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.reason).toBe("no_open_children");
  });
});
