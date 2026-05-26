/**
 * POL-92: Unit tests for adapter selection + autoDispatch gating in confirmed.ts
 *
 * Tests the selectExecutionAdapter integration and autoDispatch gate.
 * Each test gets an isolated artifact directory in .taskchain_artifacts.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { CurrentState } from "../../types/runtime-state.js";
import type { ContinuationApprovalEnvelope } from "../verification/envelope.js";
import { computeStateFingerprint } from "../verification/fingerprint.js";
import { dispatchConfirmedContinuation } from "./confirmed.js";

const ARTIFACTS_ROOT = path.join(process.cwd(), ".taskchain_artifacts");

function makeRunningState(overrides: Partial<CurrentState> = {}): CurrentState {
  return {
    schema_version: "1.0",
    run_id: "polaris-run-test-pol92",
    cluster_id: "POL-88",
    active_child: null,
    completed_children: ["POL-89", "POL-90", "POL-91"],
    open_children: ["POL-92"],
    step_cursor: "06-decide-continuation",
    context_budget: { children_completed: 3, max_children_per_session: 4 },
    status: "running",
    runtime_generation: 1,
    orchestration_mode: "bootstrap",
    continuation_epoch: 0,
    ...overrides,
  };
}

async function writeStateToDir(artifactDir: string, state: CurrentState): Promise<void> {
  const dir = path.join(ARTIFACTS_ROOT, artifactDir);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "current-state.json"), JSON.stringify(state, null, 2) + "\n", "utf-8");
}

function buildEnvelope(state: CurrentState): ContinuationApprovalEnvelope {
  const nonce = randomUUID();
  const fingerprint = computeStateFingerprint({ state, approvalNonce: nonce });
  const now = new Date();
  return {
    run_id: state.run_id,
    expected_step_cursor: state.step_cursor,
    fingerprint,
    runtime_generation: state.runtime_generation ?? 1,
    nonce,
    issued_at: now.toISOString(),
    expires_at: new Date(now.getTime() + 5 * 60 * 1000).toISOString(),
    requested_action: "loop_continue",
  };
}

let testArtifactDir: string;

beforeEach(() => {
  testArtifactDir = `test-pol92-${randomUUID().slice(0, 8)}`;
});

afterEach(async () => {
  const dir = path.join(ARTIFACTS_ROOT, testArtifactDir);
  await rm(dir, { recursive: true, force: true });
});

describe("confirmed.ts: adapter selection + autoDispatch gating", () => {
  it("agent-subtask mode → autoDispatch true → proceeds past gating (ok: true)", async () => {
    const state = makeRunningState();
    await writeStateToDir(testArtifactDir, state);
    const envelope = buildEnvelope(state);

    const result = await dispatchConfirmedContinuation({
      artifact_dir: testArtifactDir,
      envelope,
      adapterOverride: "agent-subtask",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.child_id).toBe("POL-92");
      expect(result.compact_return.status).toBe("dispatched-stub");
    }
  });

  it("terminal-cli mode → autoDispatch false → returns manual_dispatch_required rejection", async () => {
    const state = makeRunningState();
    await writeStateToDir(testArtifactDir, state);
    const envelope = buildEnvelope(state);

    const result = await dispatchConfirmedContinuation({
      artifact_dir: testArtifactDir,
      envelope,
      adapterOverride: "terminal-cli",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.rejection.check).toBe("adapter_mode");
      expect(result.rejection.reason).toBe("manual_dispatch_required");
      expect(result.rejection.detail).toContain("terminal-cli");
    }
  });

  it("ci mode → autoDispatch false → returns manual_dispatch_required rejection", async () => {
    const state = makeRunningState();
    await writeStateToDir(testArtifactDir, state);
    const envelope = buildEnvelope(state);

    const result = await dispatchConfirmedContinuation({
      artifact_dir: testArtifactDir,
      envelope,
      adapterOverride: "ci",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.rejection.check).toBe("adapter_mode");
      expect(result.rejection.reason).toBe("manual_dispatch_required");
      expect(result.rejection.detail).toContain("ci");
    }
  });

  it("no adapterOverride → auto-detects agent-subtask (insideAgentSession + nativeSubtaskAvailable) → autoDispatch true → ok", async () => {
    const state = makeRunningState();
    await writeStateToDir(testArtifactDir, state);
    const envelope = buildEnvelope(state);

    // No adapterOverride: selectExecutionAdapter called with insideAgentSession: true, nativeSubtaskAvailable: true
    // → resolves to agent-subtask → autoDispatch: true
    const result = await dispatchConfirmedContinuation({
      artifact_dir: testArtifactDir,
      envelope,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.child_id).toBe("POL-92");
    }
  });
});
