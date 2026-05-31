import { describe, it, expect } from "vitest";
import { validateEnvelope } from "../../../src/runtime/verification/envelope.js";
import { computeStateFingerprint } from "../../../src/runtime/verification/fingerprint.js";
import type { CurrentState } from "../../../src/types/runtime-state.js";
import type { ContinuationApprovalEnvelope } from "../../../src/runtime/verification/envelope.js";

const state: CurrentState = {
  schema_version: "1.0",
  run_id: "polaris-run-test",
  cluster_id: "POL-80",
  active_child: null,
  completed_children: [],
  open_children: ["POL-82", "POL-81", "POL-83"],
  step_cursor: "06-decide-continuation",
  context_budget: { children_completed: 0, max_children_per_session: 3 },
  status: "running",
  runtime_generation: 1,
  orchestration_mode: "bootstrap",
  continuation_epoch: 0,
};

function makeEnvelope(nonce: string, overrides: Partial<ContinuationApprovalEnvelope> = {}): ContinuationApprovalEnvelope {
  const fingerprint = computeStateFingerprint({ state, approvalNonce: nonce });
  return {
    run_id: state.run_id,
    expected_step_cursor: state.step_cursor,
    fingerprint,
    runtime_generation: state.runtime_generation ?? 0,
    nonce,
    requested_action: "loop_continue",
    issued_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

describe("validateEnvelope", () => {
  it("accepts a valid envelope", () => {
    const result = validateEnvelope(state, makeEnvelope("nonce-1"));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.next_child).toBe("POL-81");
  });

  it("rejects unsupported requested_action", () => {
    // @ts-expect-error — testing invalid action
    const result = validateEnvelope(state, makeEnvelope("n", { requested_action: "loop_abort" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.reason).toBe("unsupported_action");
  });

  it("rejects when run is not running", () => {
    const result = validateEnvelope({ ...state, status: "stopped" }, makeEnvelope("n"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.reason).toBe("run_not_continuable");
  });

  it("rejects when active_child is set", () => {
    const result = validateEnvelope({ ...state, active_child: "POL-81" }, makeEnvelope("n"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.reason).toBe("concurrent_execution");
  });

  it("rejects run_id mismatch", () => {
    const result = validateEnvelope(state, makeEnvelope("n", { run_id: "wrong-run" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.reason).toBe("run_id_mismatch");
  });

  it("rejects step_cursor mismatch", () => {
    const result = validateEnvelope(state, makeEnvelope("n", { expected_step_cursor: "03-execute-child" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.reason).toBe("step_cursor_mismatch");
  });

  it("rejects runtime_generation mismatch", () => {
    const result = validateEnvelope(state, makeEnvelope("n", { runtime_generation: 99 }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.reason).toBe("runtime_generation_mismatch");
  });

  it("rejects when state has mutated since approval (fingerprint mismatch)", () => {
    const envelope = makeEnvelope("nonce-2");
    // State changes after envelope was issued
    const mutatedState: CurrentState = { ...state, open_children: ["POL-81", "POL-82"] };
    const result = validateEnvelope(mutatedState, envelope);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.reason).toBe("state_mutated_since_approval");
  });

  it("rejects a replayed envelope with a different nonce", () => {
    const envelope = makeEnvelope("original-nonce");
    // Attacker replays with a different nonce — fingerprint won't match
    const replayedEnvelope = { ...envelope, nonce: "replayed-nonce" };
    const result = validateEnvelope(state, replayedEnvelope);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.reason).toBe("state_mutated_since_approval");
  });

  it("rejects when no open children remain", () => {
    const emptyState: CurrentState = { ...state, open_children: [] };
    const nonce = "n";
    const fp = computeStateFingerprint({ state: emptyState, approvalNonce: nonce });
    const result = validateEnvelope(emptyState, makeEnvelope(nonce, { fingerprint: fp }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.reason).toBe("no_open_children");
  });

  it("rejects expired approvals", () => {
    const result = validateEnvelope(state, makeEnvelope("n", {
      expires_at: new Date(Date.now() - 1000).toISOString(),
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.reason).toBe("approval_expired");
  });
});
