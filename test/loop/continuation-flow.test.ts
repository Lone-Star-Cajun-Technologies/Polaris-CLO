/**
 * POL-87: End-to-end integration test — dry-run → confirm → checkpoint
 *
 * Exercises the full continuation flow with real filesystem I/O. No mocking
 * of state or audit modules. Each test gets an isolated artifact directory
 * that is cleaned up after the test.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { CurrentState } from "../../src/types/runtime-state.js";
import type { ContinuationApprovalEnvelope } from "../../src/runtime/verification/envelope.js";
import { executeDryRun } from "../../src/runtime/continuation/dry-run.js";
import { handleLoopContinueConfirmed } from "../../src/mcp/tools/loop-continue.js";

const ARTIFACTS_ROOT = path.join(process.cwd(), ".taskchain_artifacts");

function makeRunningState(overrides: Partial<CurrentState> = {}): CurrentState {
  return {
    schema_version: "1.0",
    run_id: "polaris-run-test-pol87",
    cluster_id: "POL-80",
    active_child: null,
    completed_children: ["POL-84", "POL-85", "POL-86"],
    open_children: ["POL-87"],
    step_cursor: "06-decide-continuation",
    context_budget: { children_completed: 3, max_children_per_session: 4 },
    status: "running",
    runtime_generation: 1,
    orchestration_mode: "bootstrap",
    continuation_epoch: 0,
    ...overrides,
  };
}

async function writeState(artifactDir: string, state: CurrentState): Promise<void> {
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

async function readAuditLog(artifactDir: string): Promise<Array<Record<string, unknown>>> {
  const filePath = path.join(ARTIFACTS_ROOT, artifactDir, "audit.jsonl");
  try {
    const raw = await readFile(filePath, "utf-8");
    return raw.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

let testArtifactDir: string;

beforeEach(() => {
  testArtifactDir = `test-pol87-${randomUUID().slice(0, 8)}`;
});

afterEach(async () => {
  const dir = path.join(ARTIFACTS_ROOT, testArtifactDir);
  await rm(dir, { recursive: true, force: true });
});

describe("continuation flow: dry-run → confirmed", () => {
  it("completes the full flow and writes a checkpoint", async () => {
    const state = makeRunningState();
    await writeState(testArtifactDir, state);

    // Step 1: dry-run
    const dryRunResult = await executeDryRun({
      artifact_dir: testArtifactDir,
      expected_step_cursor: "06-decide-continuation",
    });
    expect(dryRunResult.ok).toBe(true);
    if (!dryRunResult.ok) return;

    expect(dryRunResult.preview.next_child).toBe("POL-87");
    expect(dryRunResult.preview.approval_template.run_id).toBe("polaris-run-test-pol87");
    expect(dryRunResult.preview.approval_template.nonce).toBeTruthy();

    // Step 2: build confirmed envelope from dry-run template
    const envelope = buildEnvelope(dryRunResult.preview.approval_template);

    // Step 3: confirm
    const confirmResult = await handleLoopContinueConfirmed({
      artifact_dir: testArtifactDir,
      ...envelope,
    });

    expect(confirmResult["ok"]).toBe(true);
    expect(confirmResult["next_child"]).toBe("POL-87");
    expect(typeof confirmResult["message"]).toBe("string");
  });

  it("writes a checkpoint file to disk after successful confirmation", async () => {
    await writeState(testArtifactDir, makeRunningState());

    const dryRunResult = await executeDryRun({
      artifact_dir: testArtifactDir,
      expected_step_cursor: "06-decide-continuation",
    });
    expect(dryRunResult.ok).toBe(true);
    if (!dryRunResult.ok) return;

    await handleLoopContinueConfirmed({
      artifact_dir: testArtifactDir,
      ...buildEnvelope(dryRunResult.preview.approval_template),
    });

    const checkpointsDir = path.join(ARTIFACTS_ROOT, testArtifactDir, "checkpoints");
    expect(existsSync(checkpointsDir)).toBe(true);
    const files = readdirSync(checkpointsDir).filter((f) => f.endsWith(".json"));
    expect(files.length).toBeGreaterThan(0);

    // Verify checkpoint content
    const checkpointRaw = await readFile(path.join(checkpointsDir, files[0]!), "utf-8");
    const checkpoint = JSON.parse(checkpointRaw);
    expect(checkpoint.step_cursor).toBe("06-decide-continuation");
    expect(checkpoint.state_snapshot.run_id).toBe("polaris-run-test-pol87");
  });

  it("appends expected audit events in order", async () => {
    await writeState(testArtifactDir, makeRunningState());

    const dryRunResult = await executeDryRun({
      artifact_dir: testArtifactDir,
      expected_step_cursor: "06-decide-continuation",
    });
    expect(dryRunResult.ok).toBe(true);
    if (!dryRunResult.ok) return;

    await handleLoopContinueConfirmed({
      artifact_dir: testArtifactDir,
      ...buildEnvelope(dryRunResult.preview.approval_template),
    });

    const events = await readAuditLog(testArtifactDir);
    const eventTypes = events.map((e) => e["event_type"]);
    expect(eventTypes).toContain("dry_run_executed");
    expect(eventTypes).toContain("mutation_requested");
    expect(eventTypes).toContain("checkpoint_written");
    expect(eventTypes).toContain("mutation_approved");

    // Verify correct event ordering: dry_run → mutation_requested → checkpoint → mutation_approved
    const dryRunIdx = eventTypes.indexOf("dry_run_executed");
    const mutationRequestedIdx = eventTypes.indexOf("mutation_requested");
    const checkpointIdx = eventTypes.indexOf("checkpoint_written");
    const mutationApprovedIdx = eventTypes.indexOf("mutation_approved");
    expect(dryRunIdx).toBeLessThan(mutationRequestedIdx);
    expect(mutationRequestedIdx).toBeLessThan(checkpointIdx);
    expect(checkpointIdx).toBeLessThan(mutationApprovedIdx);
  });
});

describe("continuation flow: rejection cases", () => {
  it("rejects when state has changed between dry-run and confirm (fingerprint mismatch)", async () => {
    const state = makeRunningState();
    await writeState(testArtifactDir, state);

    const dryRunResult = await executeDryRun({
      artifact_dir: testArtifactDir,
      expected_step_cursor: "06-decide-continuation",
    });
    expect(dryRunResult.ok).toBe(true);
    if (!dryRunResult.ok) return;

    // Simulate state mutation between dry-run and confirm
    const mutatedState = makeRunningState({ continuation_epoch: 99 });
    await writeState(testArtifactDir, mutatedState);

    const result = await handleLoopContinueConfirmed({
      artifact_dir: testArtifactDir,
      ...buildEnvelope(dryRunResult.preview.approval_template),
    });

    expect(result["ok"]).toBe(false);
    expect(result["rejection"]).toBeDefined();
    const rejection = result["rejection"] as Record<string, unknown>;
    const fingerprintMismatchReasons = ["state_mutated_since_approval", "runtime_generation_mismatch"];
    expect(fingerprintMismatchReasons).toContain(rejection["reason"]);
  });

  it("rejects an expired approval envelope", async () => {
    await writeState(testArtifactDir, makeRunningState());

    const dryRunResult = await executeDryRun({
      artifact_dir: testArtifactDir,
      expected_step_cursor: "06-decide-continuation",
    });
    expect(dryRunResult.ok).toBe(true);
    if (!dryRunResult.ok) return;

    const expiredEnvelope = buildEnvelope(dryRunResult.preview.approval_template, {
      issued_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      expires_at: new Date(Date.now() - 1 * 60 * 1000).toISOString(),
    });

    const result = await handleLoopContinueConfirmed({
      artifact_dir: testArtifactDir,
      ...expiredEnvelope,
    });

    expect(result["ok"]).toBe(false);
    const rejection = result["rejection"] as Record<string, unknown>;
    expect(rejection["reason"]).toBe("approval_expired");
  });

  it("rejects confirmation when run is not in running state", async () => {
    await writeState(testArtifactDir, makeRunningState({ status: "stopped" }));

    // Build a dry-run result manually since executeDryRun will also reject
    const runningState = makeRunningState();
    await writeState(testArtifactDir, runningState);
    const dryRunResult = await executeDryRun({
      artifact_dir: testArtifactDir,
      expected_step_cursor: "06-decide-continuation",
    });
    expect(dryRunResult.ok).toBe(true);
    if (!dryRunResult.ok) return;

    // Now flip state to stopped before confirming
    await writeState(testArtifactDir, makeRunningState({ status: "stopped" }));

    const result = await handleLoopContinueConfirmed({
      artifact_dir: testArtifactDir,
      ...buildEnvelope(dryRunResult.preview.approval_template),
    });

    expect(result["ok"]).toBe(false);
    const rejection = result["rejection"] as Record<string, unknown>;
    expect(rejection["reason"]).toBe("run_not_continuable");
  });

  it("records a mutation_rejected audit event on failed confirmation", async () => {
    await writeState(testArtifactDir, makeRunningState());

    const dryRunResult = await executeDryRun({
      artifact_dir: testArtifactDir,
      expected_step_cursor: "06-decide-continuation",
    });
    expect(dryRunResult.ok).toBe(true);
    if (!dryRunResult.ok) return;

    // Submit with a mismatched run_id to force rejection
    const result = await handleLoopContinueConfirmed({
      artifact_dir: testArtifactDir,
      ...buildEnvelope(dryRunResult.preview.approval_template, {
        run_id: "wrong-run-id",
      }),
    });

    expect(result["ok"]).toBe(false);

    const events = await readAuditLog(testArtifactDir);
    const eventTypes = events.map((e) => e["event_type"]);
    expect(eventTypes).toContain("mutation_rejected");

    // No checkpoint should have been written
    const checkpointsDir = path.join(ARTIFACTS_ROOT, testArtifactDir, "checkpoints");
    const checkpointFiles = existsSync(checkpointsDir)
      ? readdirSync(checkpointsDir).filter((f) => f.endsWith(".json"))
      : [];
    expect(checkpointFiles.length).toBe(0);
  });

  it("rejects nonce replay (reusing same approval envelope after successful confirm)", async () => {
    await writeState(testArtifactDir, makeRunningState());

    const dryRunResult = await executeDryRun({
      artifact_dir: testArtifactDir,
      expected_step_cursor: "06-decide-continuation",
    });
    expect(dryRunResult.ok).toBe(true);
    if (!dryRunResult.ok) return;

    const envelope = buildEnvelope(dryRunResult.preview.approval_template);

    // First confirmation succeeds
    const firstResult = await handleLoopContinueConfirmed({
      artifact_dir: testArtifactDir,
      ...envelope,
    });
    expect(firstResult["ok"]).toBe(true);

    // Replay the same envelope (same nonce)
    const replayResult = await handleLoopContinueConfirmed({
      artifact_dir: testArtifactDir,
      ...envelope,
    });

    expect(replayResult["ok"]).toBe(false);
    const rejection = replayResult["rejection"] as Record<string, unknown>;
    // concurrent_execution is also valid: active_child is now set after a successful confirm
    const nonceReplayReasons = ["state_mutated_since_approval", "runtime_generation_mismatch", "step_cursor_mismatch", "concurrent_execution"];
    expect(nonceReplayReasons).toContain(rejection["reason"]);

    const events = await readAuditLog(testArtifactDir);
    const eventTypes = events.map((e) => e["event_type"]);
    expect(eventTypes).toContain("mutation_rejected");
  });

  it("rejects concurrent execution race (two parallel confirms from same dry-run)", async () => {
    await writeState(testArtifactDir, makeRunningState());

    const dryRunResult = await executeDryRun({
      artifact_dir: testArtifactDir,
      expected_step_cursor: "06-decide-continuation",
    });
    expect(dryRunResult.ok).toBe(true);
    if (!dryRunResult.ok) return;

    // Create two envelopes from the same dry-run
    const envelope1 = buildEnvelope(dryRunResult.preview.approval_template);
    const envelope2 = buildEnvelope(dryRunResult.preview.approval_template);

    // Invoke both concurrently
    const [result1, result2] = await Promise.all([
      handleLoopContinueConfirmed({ artifact_dir: testArtifactDir, ...envelope1 }),
      handleLoopContinueConfirmed({ artifact_dir: testArtifactDir, ...envelope2 }),
    ]);

    // One should succeed, the other should fail
    const results = [result1, result2];
    const successes = results.filter((r) => r["ok"] === true);
    const failures = results.filter((r) => r["ok"] === false);

    expect(successes.length).toBe(1);
    expect(failures.length).toBe(1);

    const rejection = failures[0]!["rejection"] as Record<string, unknown>;
    const raceReasons = ["state_mutated_since_approval", "runtime_generation_mismatch", "step_cursor_mismatch", "concurrent_execution"];
    expect(raceReasons).toContain(rejection["reason"]);

    const events = await readAuditLog(testArtifactDir);
    const eventTypes = events.map((e) => e["event_type"]);
    expect(eventTypes).toContain("mutation_rejected");
  });

  it("rejects step-cursor drift (state cursor changed before confirm)", async () => {
    await writeState(testArtifactDir, makeRunningState());

    const dryRunResult = await executeDryRun({
      artifact_dir: testArtifactDir,
      expected_step_cursor: "06-decide-continuation",
    });
    expect(dryRunResult.ok).toBe(true);
    if (!dryRunResult.ok) return;

    // Mutate the state's step_cursor before confirming
    await writeState(testArtifactDir, makeRunningState({ step_cursor: "07-somewhere-else" }));

    const result = await handleLoopContinueConfirmed({
      artifact_dir: testArtifactDir,
      ...buildEnvelope(dryRunResult.preview.approval_template),
    });

    expect(result["ok"]).toBe(false);
    const rejection = result["rejection"] as Record<string, unknown>;
    expect(rejection["reason"]).toBe("step_cursor_mismatch");

    const events = await readAuditLog(testArtifactDir);
    const eventTypes = events.map((e) => e["event_type"]);
    expect(eventTypes).toContain("mutation_rejected");

    // No checkpoint should have been written
    const checkpointsDir = path.join(ARTIFACTS_ROOT, testArtifactDir, "checkpoints");
    const checkpointFiles = existsSync(checkpointsDir)
      ? readdirSync(checkpointsDir).filter((f) => f.endsWith(".json"))
      : [];
    expect(checkpointFiles.length).toBe(0);
  });
});

describe("dry-run only: rejection cases", () => {
  it("rejects dry-run when no open children remain", async () => {
    await writeState(testArtifactDir, makeRunningState({ open_children: [] }));

    const result = await executeDryRun({
      artifact_dir: testArtifactDir,
      expected_step_cursor: "06-decide-continuation",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejection.reason).toBe("no_open_children");
  });

  it("rejects dry-run for a non-running state", async () => {
    await writeState(testArtifactDir, makeRunningState({ status: "complete" }));

    const result = await executeDryRun({
      artifact_dir: testArtifactDir,
      expected_step_cursor: "06-decide-continuation",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejection.reason).toBe("run_not_continuable");
  });

  it("rejects dry-run when artifact_dir does not exist", async () => {
    const result = await executeDryRun({
      artifact_dir: `nonexistent-${randomUUID()}`,
      expected_step_cursor: "06-decide-continuation",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejection.reason).toBe("run_not_found");
  });
});
