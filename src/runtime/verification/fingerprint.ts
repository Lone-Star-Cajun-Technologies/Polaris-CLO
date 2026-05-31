import { createHash } from "node:crypto";
import type { CurrentState } from "../../types/runtime-state.js";

export interface FingerprintInputs {
  state: CurrentState;
  approvalNonce?: string;
}

/**
 * Compute a replay-resistant state fingerprint.
 *
 * Scope includes all fields that must not change between dry-run issuance and
 * confirmed continuation. The approval_nonce (when present) ties the fingerprint
 * to a specific approval issuance, preventing pre-computation and replay attacks.
 */
export function computeStateFingerprint({ state, approvalNonce }: FingerprintInputs): string {
  const canonical = JSON.stringify({
    schema_version: state.schema_version,
    runtime_generation: state.runtime_generation ?? 0,
    run_id: state.run_id,
    step_cursor: state.step_cursor,
    active_child: state.active_child ?? null,
    status: state.status,
    orchestration_mode: state.orchestration_mode ?? "bootstrap",
    continuation_epoch: state.continuation_epoch ?? 0,
    open_children: [...state.open_children].sort(),
    approval_nonce: approvalNonce ?? null,
  });
  return createHash("sha256").update(canonical).digest("hex");
}
