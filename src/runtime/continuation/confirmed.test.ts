/**
 * POL-92: Unit tests for adapter selection + autoDispatch gating in confirmed.ts
 *
 * Tests the selectExecutionAdapter integration and autoDispatch gate.
 * Each test gets an isolated artifact directory in .taskchain_artifacts.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { CurrentState } from "../../types/runtime-state.js";
import type { ContinuationApprovalEnvelope } from "../verification/envelope.js";
import type { BootstrapPacket, DispatchOptions, DispatchResult, ExecutionAdapter } from "../../loop/adapters/types.js";
import { computeStateFingerprint } from "../verification/fingerprint.js";
import { dispatchConfirmedContinuation } from "./confirmed.js";

async function readAuditLog(artifactDir: string): Promise<Array<Record<string, unknown>>> {
  const filePath = path.join(ARTIFACTS_ROOT, artifactDir, "audit.jsonl");
  try {
    const raw = await readFile(filePath, "utf-8");
    return raw.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function makeMockAdapter(result: { status: string; state_updated: boolean }): () => ExecutionAdapter {
  return () => ({
    name: "mock-adapter",
    // eslint-disable-next-line no-unused-vars
    async dispatch(_packet: BootstrapPacket, _options: DispatchOptions): Promise<DispatchResult> {
      return {
        exit_code: 0,
        provider_used: "mock",
        command_run: "mock",
        summary: JSON.stringify(result),
      };
    },
  });
}

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

describe("confirmed.ts: POL-93 dispatch + CompactReturn handling", () => {
  it("mock adapter state_updated: true → active_child NOT cleared, worker_dispatched and worker_result_received in audit log", async () => {
    const state = makeRunningState();
    await writeStateToDir(testArtifactDir, state);
    const envelope = buildEnvelope(state);

    const result = await dispatchConfirmedContinuation({
      artifact_dir: testArtifactDir,
      envelope,
      adapterOverride: "agent-subtask",
      _adapterFactory: makeMockAdapter({ status: "done", state_updated: true }),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.child_id).toBe("POL-92");
      expect(result.compact_return.status).toBe("done");
      expect(result.compact_return.state_updated).toBe(true);
    }

    const events = await readAuditLog(testArtifactDir);
    const dispatchedIdx = events.findIndex((e) => e["event_type"] === "worker_dispatched");
    const receivedIdx = events.findIndex((e) => e["event_type"] === "worker_result_received");

    expect(dispatchedIdx).toBeGreaterThanOrEqual(0);
    expect(receivedIdx).toBeGreaterThanOrEqual(0);
    // worker_dispatched must appear before worker_result_received
    expect(dispatchedIdx).toBeLessThan(receivedIdx);

    const dispatched = events[dispatchedIdx];
    expect(dispatched["child_id"]).toBe("POL-92");
    expect(dispatched["operator"]).toBe("mcp");
    expect(dispatched["operation"]).toBe("confirmed_dispatch");
    expect(dispatched["result"]).toBe("ok");

    const received = events[receivedIdx];
    expect(received["child_id"]).toBe("POL-92");
    expect((received["metadata"] as Record<string, unknown>)["status"]).toBe("done");

    // active_child should NOT be cleared by confirmed.ts (state_updated: true means adapter handled it)
    // We can verify no recovery_attempted event was emitted
    const recovery = events.find((e) => e["event_type"] === "recovery_attempted");
    expect(recovery).toBeUndefined();
  });

  it("mock adapter state_updated: false → active_child defensively cleared + recovery_attempted emitted", async () => {
    const state = makeRunningState();
    await writeStateToDir(testArtifactDir, state);
    const envelope = buildEnvelope(state);

    const result = await dispatchConfirmedContinuation({
      artifact_dir: testArtifactDir,
      envelope,
      adapterOverride: "agent-subtask",
      _adapterFactory: makeMockAdapter({ status: "dispatched-stub", state_updated: false }),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.compact_return.state_updated).toBe(false);
    }

    const events = await readAuditLog(testArtifactDir);
    const recovery = events.find((e) => e["event_type"] === "recovery_attempted");
    expect(recovery).toBeDefined();
    expect(recovery!["result"]).toBe("ok");
    expect((recovery!["metadata"] as Record<string, unknown>)["reason"]).toBe("state_updated_false");
  });

  it("worker_dispatched event appears before worker_result_received in audit log", async () => {
    const state = makeRunningState();
    await writeStateToDir(testArtifactDir, state);
    const envelope = buildEnvelope(state);

    await dispatchConfirmedContinuation({
      artifact_dir: testArtifactDir,
      envelope,
      adapterOverride: "agent-subtask",
      _adapterFactory: makeMockAdapter({ status: "done", state_updated: true }),
    });

    const events = await readAuditLog(testArtifactDir);
    const types = events.map((e) => e["event_type"]);
    const dispatchedIdx = types.indexOf("worker_dispatched");
    const receivedIdx = types.indexOf("worker_result_received");
    expect(dispatchedIdx).toBeGreaterThanOrEqual(0);
    expect(receivedIdx).toBeGreaterThanOrEqual(0);
    expect(dispatchedIdx).toBeLessThan(receivedIdx);
  });
});
