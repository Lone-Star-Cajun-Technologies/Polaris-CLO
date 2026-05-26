/**
 * POL-96: End-to-end tests for handleLoopContinueConfirmed MCP response shape.
 *
 * Covers:
 *   1. Full success path — response includes ok, child_id, compact_return
 *   2. Dispatch failure path (adapter_mode / terminal-cli) — response includes ok: false, rejection
 *   3. pendingConfirmations lock released on error (state_not_found)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { CurrentState } from "../../types/runtime-state.js";
import type { ContinuationApprovalEnvelope } from "../../runtime/verification/envelope.js";
import { executeDryRun } from "../../runtime/continuation/dry-run.js";
import { handleLoopContinueConfirmed } from "./loop-continue.js";
import * as confirmedModule from "../../runtime/continuation/confirmed.js";

// Mock the confirmed module so we can control dispatchConfirmedContinuation in Test 1
vi.mock("../../runtime/continuation/confirmed.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../runtime/continuation/confirmed.js")>();
  return {
    ...original,
    dispatchConfirmedContinuation: vi.fn(original.dispatchConfirmedContinuation),
  };
});

const ARTIFACTS_ROOT = path.join(process.cwd(), ".taskchain_artifacts");

function makeRunningState(overrides: Partial<CurrentState> = {}): CurrentState {
  return {
    schema_version: "1.0",
    run_id: "polaris-run-test-pol96",
    cluster_id: "POL-88",
    active_child: null,
    completed_children: ["POL-91", "POL-92", "POL-93"],
    open_children: ["POL-96"],
    step_cursor: "06-decide-continuation",
    context_budget: { children_completed: 3, max_children_per_session: 4 },
    status: "running",
    runtime_generation: 1,
    orchestration_mode: "bootstrap",
    continuation_epoch: 0,
    ...overrides,
  };
}

async function writeStateFile(artifactDir: string, state: CurrentState): Promise<void> {
  const dir = path.join(ARTIFACTS_ROOT, artifactDir);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "current-state.json"), JSON.stringify(state, null, 2) + "\n", "utf-8");
}

function buildEnvelope(
  template: Omit<ContinuationApprovalEnvelope, "issued_at" | "expires_at">,
  overrides: Partial<ContinuationApprovalEnvelope> = {},
): ContinuationApprovalEnvelope {
  const now = new Date();
  return {
    ...template,
    issued_at: now.toISOString(),
    expires_at: new Date(now.getTime() + 5 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

let testArtifactDir: string;

beforeEach(() => {
  testArtifactDir = `test-pol96-${randomUUID().slice(0, 8)}`;
  vi.mocked(confirmedModule.dispatchConfirmedContinuation).mockRestore();
});

afterEach(async () => {
  const dir = path.join(ARTIFACTS_ROOT, testArtifactDir);
  await rm(dir, { recursive: true, force: true });
});

describe("handleLoopContinueConfirmed — MCP response shape", () => {
  it("Test 1: full success path returns ok, child_id, and compact_return", async () => {
    await writeStateFile(testArtifactDir, makeRunningState());

    const dryRunResult = await executeDryRun({
      artifact_dir: testArtifactDir,
      expected_step_cursor: "06-decide-continuation",
    });
    expect(dryRunResult.ok).toBe(true);
    if (!dryRunResult.ok) return;

    const envelope = buildEnvelope(dryRunResult.preview.approval_template);

    // Override dispatch to return a controlled success result (avoids AgentSubtaskAdapter I/O)
    vi.mocked(confirmedModule.dispatchConfirmedContinuation).mockResolvedValueOnce({
      ok: true,
      child_id: "POL-96",
      compact_return: { status: "done", state_updated: true, exit_code: 0 },
    });

    const result = await handleLoopContinueConfirmed({
      artifact_dir: testArtifactDir,
      ...envelope,
    });

    expect(result["ok"]).toBe(true);
    expect(result["child_id"]).toBe("POL-96");
    expect(result["compact_return"]).toBeDefined();
    const compactReturn = result["compact_return"] as Record<string, unknown>;
    expect(compactReturn["status"]).toBe("done");
    expect(compactReturn["state_updated"]).toBe(true);

    expect(vi.mocked(confirmedModule.dispatchConfirmedContinuation)).toHaveBeenCalledTimes(1);
  });

  it("Test 2: dispatch failure (terminal-cli adapter) returns ok: false with rejection", async () => {
    await writeStateFile(testArtifactDir, makeRunningState());

    const dryRunResult = await executeDryRun({
      artifact_dir: testArtifactDir,
      expected_step_cursor: "06-decide-continuation",
    });
    expect(dryRunResult.ok).toBe(true);
    if (!dryRunResult.ok) return;

    const envelope = buildEnvelope(dryRunResult.preview.approval_template);

    // Use adapterOverride: "terminal-cli" via args to trigger manual_dispatch_required
    // (real code path — no mock needed)
    const result = await handleLoopContinueConfirmed({
      artifact_dir: testArtifactDir,
      adapterOverride: "terminal-cli",
      ...envelope,
    });

    expect(result["ok"]).toBe(false);
    expect(result["rejection"]).toBeDefined();
    const rejection = result["rejection"] as Record<string, unknown>;
    expect(rejection["check"]).toBe("adapter_mode");
    expect(rejection["reason"]).toBe("manual_dispatch_required");
  });

  it("Test 3: pendingConfirmations lock released on state_not_found error", async () => {
    // No state written — triggers state_not_found path
    const result = await handleLoopContinueConfirmed({
      artifact_dir: testArtifactDir,
      run_id: "polaris-run-test-pol96",
      expected_step_cursor: "06-decide-continuation",
      fingerprint: "dummy-fingerprint",
      nonce: randomUUID(),
      issued_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      requested_action: "loop_continue",
      runtime_generation: 1,
    });

    expect(result["ok"]).toBe(false);
    expect(result["error"]).toBe("state_not_found");

    // Verify lock is released: a subsequent call for the same artifact_dir should
    // return state_not_found again, not concurrent_execution
    const result2 = await handleLoopContinueConfirmed({
      artifact_dir: testArtifactDir,
      run_id: "polaris-run-test-pol96",
      expected_step_cursor: "06-decide-continuation",
      fingerprint: "dummy-fingerprint",
      nonce: randomUUID(),
      issued_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      requested_action: "loop_continue",
      runtime_generation: 1,
    });

    expect(result2["ok"]).toBe(false);
    expect(result2["error"]).toBe("state_not_found");
  });
});
