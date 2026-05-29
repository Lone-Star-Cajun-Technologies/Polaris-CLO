import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runLoopDispatch } from "./dispatch.js";
import { readState } from "./checkpoint.js";
import { createBootstrapSeal } from "./run-bootstrap.js";

function makeTestDir(): string {
  const dir = join(tmpdir(), `polaris-dispatch-test-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, ".git"), { recursive: true });
  writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/test-branch\n");
  return dir;
}

function baseState(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    schema_version: "1.0",
    run_id: "pol-142-session-1",
    cluster_id: "POL-142",
    session_type: "implement",
    branch: "test-branch",
    active_child: "",
    completed_children: ["POL-144"],
    open_children: ["POL-145", "POL-146"],
    open_children_meta: {
      "POL-145": { title: "Add dispatch command", labels: ["implement"] },
      "POL-146": { title: "Parent delivery", labels: ["implement"] },
    },
    step_cursor: "checkpoint",
    context_budget: { children_completed: 1, max_children_per_session: 3 },
    status: "running",
    next_open_child: "POL-145",
    dispatch_boundary: { dispatch_epoch: 1, continue_epoch: 1, last_dispatched_child: "POL-144" },
    run_bootstrap_seal: createBootstrapSeal("pol-142-session-1", "POL-142", ["POL-145", "POL-146"]),
    ...overrides,
  };
}

function writeState(dir: string, state: object): string {
  const stateFile = join(dir, ".taskchain_artifacts", "polaris-run", "current-state.json");
  mkdirSync(join(dir, ".taskchain_artifacts", "polaris-run"), { recursive: true });
  writeFileSync(stateFile, JSON.stringify(state, null, 2), "utf-8");
  return stateFile;
}

function captureStdout(fn: () => void): string {
  const chunks: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk: string | Buffer) => {
    chunks.push(chunk.toString());
    return true;
  };
  try {
    fn();
  } finally {
    process.stdout.write = originalWrite;
  }
  return chunks.join("");
}

function expectDispatchError(fn: () => void): string {
  const chunks: string[] = [];
  const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
    throw new Error("process.exit called");
  });
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk: string | Buffer) => {
    chunks.push(chunk.toString());
    return true;
  };
  try {
    expect(fn).toThrow("process.exit called");
    expect(exitSpy).toHaveBeenCalledWith(1);
  } finally {
    process.stderr.write = originalWrite;
    exitSpy.mockRestore();
  }
  return chunks.join("");
}

describe("runLoopDispatch", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = makeTestDir();
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("dispatches first open child when no --child is specified", () => {
    const stateFile = writeState(testDir, baseState());

    const output = captureStdout(() => runLoopDispatch({ repoRoot: testDir, stateFile }));
    const packet = JSON.parse(output);
    const updated = readState(stateFile);

    expect(packet.schema_version).toBe("2.1");
    expect(packet.active_child).toBe("POL-145");
    expect(updated.active_child).toBe("POL-145");
    expect(updated.open_children).toEqual(["POL-145", "POL-146"]);
  });

  it("dispatches named child when --child is specified", () => {
    const stateFile = writeState(testDir, baseState());

    const output = captureStdout(() =>
      runLoopDispatch({ repoRoot: testDir, stateFile, childId: "POL-146" }),
    );
    const packet = JSON.parse(output);
    const updated = readState(stateFile);

    expect(packet.active_child).toBe("POL-146");
    expect(packet.instructions.issue_context).toMatchObject({ id: "POL-146" });
    expect(updated.active_child).toBe("POL-146");
  });

  it("errors when active_child is already set", () => {
    const stateFile = writeState(testDir, baseState({ active_child: "POL-145" }));

    const stderr = expectDispatchError(() => runLoopDispatch({ repoRoot: testDir, stateFile }));

    expect(stderr).toContain("active_child is already set");
  });

  it("errors when open_children is empty", () => {
    const stateFile = writeState(
      testDir,
      baseState({ completed_children: ["POL-144", "POL-145"], open_children: [] }),
    );

    const stderr = expectDispatchError(() => runLoopDispatch({ repoRoot: testDir, stateFile }));

    expect(stderr).toContain("no open children");
  });

  it("claims active_child without advancing completion state", () => {
    const stateFile = writeState(testDir, baseState());

    captureStdout(() => runLoopDispatch({ repoRoot: testDir, stateFile }));

    const updated = readState(stateFile);
    expect(updated.active_child).toBe("POL-145");
    expect(updated.completed_children).toEqual(["POL-144"]);
    expect(updated.open_children).toEqual(["POL-145", "POL-146"]);
    expect(updated.status).toBe("running");
  });

  it("emits exactly one child-dispatched JSONL event", () => {
    const artifactDir = join(testDir, ".taskchain_artifacts", "polaris-run");
    const stateFile = writeState(testDir, baseState({ artifact_dir: artifactDir }));

    captureStdout(() => runLoopDispatch({ repoRoot: testDir, stateFile }));

    const telemetryFile = join(artifactDir, "runs", "pol-142-session-1", "telemetry.jsonl");
    expect(existsSync(telemetryFile)).toBe(true);
    const events = readFileSync(telemetryFile, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((event) => event.event === "child-dispatched");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      run_id: "pol-142-session-1",
      child_id: "POL-145",
    });
  });

  it("appends child-dispatched to the global ledger and creates it when absent", () => {
    const artifactDir = join(testDir, ".taskchain_artifacts", "polaris-run");
    const stateFile = writeState(testDir, baseState({ artifact_dir: artifactDir }));

    captureStdout(() => runLoopDispatch({ repoRoot: testDir, stateFile }));

    const ledgerFile = join(testDir, ".polaris", "runs", "ledger.jsonl");
    expect(existsSync(ledgerFile)).toBe(true);
    const events = readFileSync(ledgerFile, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: "child-dispatched",
      run_id: "pol-142-session-1",
      run_type: "implement",
      cluster_id: "POL-142",
      issue_id: "POL-145",
      branch: "test-branch",
      status: "child-dispatched",
      completed_children: ["POL-144"],
      open_children: ["POL-145", "POL-146"],
      next_child: "POL-145",
      last_commit: null,
      pr_url: null,
      dispatch_epoch: 2,
    });
  });

  // ── REGRESSION TESTS: Dispatch durable evidence ─────────────────────────────

  it("writes packet artifact to cluster-scoped layout", () => {
    const stateFile = writeState(testDir, baseState());

    captureStdout(() => runLoopDispatch({ repoRoot: testDir, stateFile }));

    // Check that packet was written to cluster-scoped directory
    const clusterPacketDir = join(testDir, ".polaris", "clusters", "POL-142", "packets");
    expect(existsSync(clusterPacketDir)).toBe(true);

    // Get the actual dispatched state to find the packet path
    const updated = readState(stateFile);
    const dispatchRecord = updated.open_children_meta?.["POL-145"]?.dispatch_record;
    expect(dispatchRecord).toBeDefined();
    expect(dispatchRecord?.packet_path).toBeDefined();
    expect(existsSync(dispatchRecord?.packet_path!)).toBe(true);

    // Read the packet and verify it contains expected fields
    const packet = JSON.parse(readFileSync(dispatchRecord?.packet_path!, "utf-8"));
    expect(packet.schema_version).toBe("2.1");
    expect(packet.active_child).toBe("POL-145");
    expect(packet.run_id).toBe("pol-142-session-1");
    expect(packet.cluster_id).toBe("POL-142");
  });

  it("records dispatch_record with packet and result paths in open_children_meta", () => {
    const stateFile = writeState(testDir, baseState());

    captureStdout(() => runLoopDispatch({ repoRoot: testDir, stateFile }));

    const updated = readState(stateFile);
    const childMeta = updated.open_children_meta?.["POL-145"];

    expect(childMeta).toBeDefined();
    expect(childMeta?.dispatch_record).toBeDefined();

    const dispatchRecord = childMeta?.dispatch_record;
    expect(dispatchRecord?.child_id).toBe("POL-145");
    expect(dispatchRecord?.run_id).toBe("pol-142-session-1");
    expect(dispatchRecord?.cluster_id).toBe("POL-142");
    expect(dispatchRecord?.status).toBe("dispatched");

    // Verify paths are set and exist
    expect(dispatchRecord?.packet_path).toBeDefined();
    expect(existsSync(dispatchRecord?.packet_path!)).toBe(true);

    // Verify expected result path is set (won't exist yet - worker creates it)
    expect(dispatchRecord?.expected_result_path).toBeDefined();
    expect(dispatchRecord?.expected_result_path).toContain("results");
    expect(dispatchRecord?.expected_result_path).toContain("POL-145");
  });

  it("telemetry includes packet_path and expected_result_path", () => {
    const artifactDir = join(testDir, ".taskchain_artifacts", "polaris-run");
    const stateFile = writeState(testDir, baseState({ artifact_dir: artifactDir }));

    captureStdout(() => runLoopDispatch({ repoRoot: testDir, stateFile }));

    const telemetryFile = join(artifactDir, "runs", "pol-142-session-1", "telemetry.jsonl");
    expect(existsSync(telemetryFile)).toBe(true);

    const events = readFileSync(telemetryFile, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((event) => event.event === "child-dispatched");

    expect(events).toHaveLength(1);
    expect(events[0].packet_path).toBeDefined();
    expect(events[0].expected_result_path).toBeDefined();
    expect(events[0].packet_path).toContain("POL-142");
    expect(events[0].packet_path).toContain("packets");
  });

  // ── DISPATCH MODE TESTS ────────────────────────────────────────────────────

  it("records delegated dispatch mode when no provider specified", () => {
    const stateFile = writeState(testDir, baseState());

    captureStdout(() => runLoopDispatch({ repoRoot: testDir, stateFile }));

    const updated = readState(stateFile);
    const dispatchRecord = updated.open_children_meta?.["POL-145"]?.dispatch_record;

    expect(dispatchRecord).toBeDefined();
    expect(dispatchRecord?.dispatch_mode).toBe("delegated");
    expect(dispatchRecord?.runtime_state).toBe("delegated");
    expect(dispatchRecord?.provider).toBeUndefined();
  });

  it("records direct-worker dispatch mode when provider is specified", () => {
    const stateFile = writeState(testDir, baseState());

    captureStdout(() => runLoopDispatch({
      repoRoot: testDir,
      stateFile,
      provider: "copilot"
    }));

    const updated = readState(stateFile);
    const dispatchRecord = updated.open_children_meta?.["POL-145"]?.dispatch_record;

    expect(dispatchRecord).toBeDefined();
    expect(dispatchRecord?.dispatch_mode).toBe("direct-worker");
    expect(dispatchRecord?.runtime_state).toBe("packet-created");
    expect(dispatchRecord?.provider).toBe("copilot");
  });

  it("emits dispatch_mode and runtime_state in telemetry", () => {
    const artifactDir = join(testDir, ".taskchain_artifacts", "polaris-run");
    const stateFile = writeState(testDir, baseState({ artifact_dir: artifactDir }));

    captureStdout(() => runLoopDispatch({
      repoRoot: testDir,
      stateFile,
      provider: "gemini"
    }));

    const telemetryFile = join(artifactDir, "runs", "pol-142-session-1", "telemetry.jsonl");
    const events = readFileSync(telemetryFile, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((event) => event.event === "child-dispatched");

    expect(events).toHaveLength(1);
    expect(events[0].dispatch_mode).toBe("direct-worker");
    expect(events[0].runtime_state).toBe("packet-created");
    expect(events[0].provider).toBe("gemini");
  });

  // ── DELEGATED ASSIGNMENT TESTS (POL-220) ──────────────────────────────────

  it("escalation path: emits all fallback telemetry events and sets pending-escalation when no subagent available", () => {
    const artifactDir = join(testDir, ".taskchain_artifacts", "polaris-run");
    const stateFile = writeState(testDir, baseState({ artifact_dir: artifactDir }));

    // No subagent dispatcher registered — escalation path
    captureStdout(() => runLoopDispatch({ repoRoot: testDir, stateFile }));

    const telemetryFile = join(artifactDir, "runs", "pol-142-session-1", "telemetry.jsonl");
    const allEvents = readFileSync(telemetryFile, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    const attemptedEvents = allEvents.filter((e) => e.event === "worker-assignment-attempted");
    const failedEvents = allEvents.filter((e) => e.event === "worker-assignment-failed");
    const escalationEvents = allEvents.filter((e) => e.event === "escalation-initiated");

    // Three attempts: subagent, external-process, human-handoff
    expect(attemptedEvents).toHaveLength(3);
    expect(attemptedEvents[0].assignment_type).toBe("subagent");
    expect(attemptedEvents[1].assignment_type).toBe("external-process");
    expect(attemptedEvents[2].assignment_type).toBe("human-handoff");

    // Three failures
    expect(failedEvents).toHaveLength(3);
    expect(failedEvents[0].reason).toBe("no-subagent-support");
    expect(failedEvents[1].reason).toBe("provider-unavailable");
    expect(failedEvents[2].reason).toBe("provider-unavailable");

    // One escalation-initiated
    expect(escalationEvents).toHaveLength(1);
    expect(escalationEvents[0].reason).toBeDefined();
    expect(escalationEvents[0].recommended_action).toBe("manual-dispatch");

    // All events have required base fields
    for (const ev of [...attemptedEvents, ...failedEvents, ...escalationEvents]) {
      expect(ev.event_id).toBeDefined();
      expect(ev.dispatch_id).toBeDefined();
      expect(ev.run_id).toBe("pol-142-session-1");
      expect(ev.child_id).toBe("POL-145");
      expect(ev.timestamp).toBeDefined();
    }
  });

  it("escalation path: sets pending-escalation in worker_assignment on dispatch_record", () => {
    const stateFile = writeState(testDir, baseState());

    // No subagent dispatcher registered
    captureStdout(() => runLoopDispatch({ repoRoot: testDir, stateFile }));

    const updated = readState(stateFile);
    const dispatchRecord = updated.open_children_meta?.["POL-145"]?.dispatch_record;

    expect(dispatchRecord?.worker_assignment).toBeDefined();
    expect(dispatchRecord?.worker_assignment?.assignment_type).toBe("pending-escalation");
    expect(dispatchRecord?.worker_assignment?.assigned_at).toBeDefined();
    expect(dispatchRecord?.worker_assignment?.escalation_reason).toBeDefined();
    expect(dispatchRecord?.session_id).toBeNull();
    expect(dispatchRecord?.attachment_capable).toBe(false);
    expect(dispatchRecord?.runtime_state).toBe("delegated");
  });

  it("successful subagent assignment: sets worker_assignment with subagent session_id", () => {
    const stateFile = writeState(testDir, baseState());

    // Register a mock subagent dispatcher
    const mockDispatcher = vi.fn().mockResolvedValue(
      JSON.stringify({ child_id: "POL-145", status: "done", validation_summary: "ok", next_action: "continue" })
    );
    (globalThis as Record<string, unknown>).__POLARIS_AGENT_SUBTASK_DISPATCH__ = mockDispatcher;

    try {
      captureStdout(() => runLoopDispatch({ repoRoot: testDir, stateFile }));

      const updated = readState(stateFile);
      const dispatchRecord = updated.open_children_meta?.["POL-145"]?.dispatch_record;

      expect(dispatchRecord?.worker_assignment).toBeDefined();
      expect(dispatchRecord?.worker_assignment?.assignment_type).toBe("subagent");
      expect(dispatchRecord?.worker_assignment?.assigned_at).toBeDefined();
      expect(dispatchRecord?.worker_assignment?.subagent_session_id).toBeDefined();
      expect(typeof dispatchRecord?.worker_assignment?.subagent_session_id).toBe("string");
      expect(dispatchRecord?.session_id).toBe(dispatchRecord?.worker_assignment?.subagent_session_id);
      expect(dispatchRecord?.attachment_capable).toBe(false);
      expect(dispatchRecord?.runtime_state).toBe("delegated");
    } finally {
      delete (globalThis as Record<string, unknown>).__POLARIS_AGENT_SUBTASK_DISPATCH__;
    }
  });

  it("successful subagent assignment: emits worker-assignment-attempted and worker-assigned events", () => {
    const artifactDir = join(testDir, ".taskchain_artifacts", "polaris-run");
    const stateFile = writeState(testDir, baseState({ artifact_dir: artifactDir }));

    const mockDispatcher = vi.fn().mockResolvedValue(
      JSON.stringify({ child_id: "POL-145", status: "done", validation_summary: "ok", next_action: "continue" })
    );
    (globalThis as Record<string, unknown>).__POLARIS_AGENT_SUBTASK_DISPATCH__ = mockDispatcher;

    try {
      captureStdout(() => runLoopDispatch({ repoRoot: testDir, stateFile }));

      const telemetryFile = join(artifactDir, "runs", "pol-142-session-1", "telemetry.jsonl");
      const allEvents = readFileSync(telemetryFile, "utf-8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));

      const attemptedEvents = allEvents.filter((e) => e.event === "worker-assignment-attempted");
      const assignedEvents = allEvents.filter((e) => e.event === "worker-assigned");
      const failedEvents = allEvents.filter((e) => e.event === "worker-assignment-failed");
      const escalationEvents = allEvents.filter((e) => e.event === "escalation-initiated");

      // Only one attempt (subagent succeeds)
      expect(attemptedEvents).toHaveLength(1);
      expect(attemptedEvents[0].assignment_type).toBe("subagent");

      // One assigned event
      expect(assignedEvents).toHaveLength(1);
      expect(assignedEvents[0].assignment_type).toBe("subagent");
      expect(assignedEvents[0].subagent_session_id).toBeDefined();

      // No failures or escalations
      expect(failedEvents).toHaveLength(0);
      expect(escalationEvents).toHaveLength(0);
    } finally {
      delete (globalThis as Record<string, unknown>).__POLARIS_AGENT_SUBTASK_DISPATCH__;
    }
  });

  it("direct-worker mode: no assignment events emitted (provider specified)", () => {
    const artifactDir = join(testDir, ".taskchain_artifacts", "polaris-run");
    const stateFile = writeState(testDir, baseState({ artifact_dir: artifactDir }));

    captureStdout(() => runLoopDispatch({ repoRoot: testDir, stateFile, provider: "copilot" }));

    const telemetryFile = join(artifactDir, "runs", "pol-142-session-1", "telemetry.jsonl");
    const allEvents = readFileSync(telemetryFile, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    const assignmentEvents = allEvents.filter((e) =>
      ["worker-assignment-attempted", "worker-assigned", "worker-assignment-failed", "escalation-initiated"].includes(e.event)
    );

    expect(assignmentEvents).toHaveLength(0);
  });

  it("direct-worker mode: no worker_assignment on dispatch_record", () => {
    const stateFile = writeState(testDir, baseState());

    captureStdout(() => runLoopDispatch({ repoRoot: testDir, stateFile, provider: "copilot" }));

    const updated = readState(stateFile);
    const dispatchRecord = updated.open_children_meta?.["POL-145"]?.dispatch_record;

    expect(dispatchRecord?.worker_assignment).toBeUndefined();
  });
});
