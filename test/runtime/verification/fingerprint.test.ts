import { describe, it, expect } from "vitest";
import { computeStateFingerprint } from "../../../src/runtime/verification/fingerprint.js";
import type { CurrentState } from "../../../src/types/runtime-state.js";

const base: CurrentState = {
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

describe("computeStateFingerprint", () => {
  it("is deterministic for the same inputs", () => {
    expect(computeStateFingerprint({ state: base })).toBe(
      computeStateFingerprint({ state: base })
    );
  });

  it("is order-independent for open_children", () => {
    const shuffled: CurrentState = { ...base, open_children: ["POL-83", "POL-81", "POL-82"] };
    expect(computeStateFingerprint({ state: base })).toBe(
      computeStateFingerprint({ state: shuffled })
    );
  });

  it("changes when run_id changes", () => {
    expect(computeStateFingerprint({ state: base })).not.toBe(
      computeStateFingerprint({ state: { ...base, run_id: "other-run" } })
    );
  });

  it("changes when step_cursor changes", () => {
    expect(computeStateFingerprint({ state: base })).not.toBe(
      computeStateFingerprint({ state: { ...base, step_cursor: "03-execute-child" } })
    );
  });

  it("changes when runtime_generation changes", () => {
    expect(computeStateFingerprint({ state: base })).not.toBe(
      computeStateFingerprint({ state: { ...base, runtime_generation: 2 } })
    );
  });

  it("changes when orchestration_mode changes", () => {
    expect(computeStateFingerprint({ state: base })).not.toBe(
      computeStateFingerprint({ state: { ...base, orchestration_mode: "native" } })
    );
  });

  it("changes when continuation_epoch changes", () => {
    expect(computeStateFingerprint({ state: base })).not.toBe(
      computeStateFingerprint({ state: { ...base, continuation_epoch: 1 } })
    );
  });

  it("changes when a nonce is added", () => {
    expect(computeStateFingerprint({ state: base })).not.toBe(
      computeStateFingerprint({ state: base, approvalNonce: "abc-123" })
    );
  });

  it("is the same for the same nonce", () => {
    const nonce = "test-nonce";
    expect(computeStateFingerprint({ state: base, approvalNonce: nonce })).toBe(
      computeStateFingerprint({ state: base, approvalNonce: nonce })
    );
  });

  it("defaults missing extended fields to stable values", () => {
    const minimal: CurrentState = {
      schema_version: "1.0",
      run_id: "r1",
      cluster_id: "POL-1",
      active_child: null,
      completed_children: [],
      open_children: [],
      step_cursor: "01-load-cluster",
      context_budget: { children_completed: 0, max_children_per_session: 3 },
      status: "running",
    };
    const withDefaults: CurrentState = {
      ...minimal,
      runtime_generation: 0,
      orchestration_mode: "bootstrap",
      continuation_epoch: 0,
    };
    expect(computeStateFingerprint({ state: minimal })).toBe(
      computeStateFingerprint({ state: withDefaults })
    );
  });
});
