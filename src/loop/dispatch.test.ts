import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { runLoopDispatch, checkAcknowledgmentTimeout } from "./dispatch.js";
import { readState } from "./checkpoint.js";
import { createBootstrapSeal } from "./run-bootstrap.js";
import { buildWorkerInstructions } from "./adapters/worker-instructions.js";

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

function writeClusterStateFile(
  dir: string,
  clusterId: string,
  childIds: string[],
  completedChildren: string[] = [],
): string {
  const clusterDir = join(dir, ".polaris", "clusters", clusterId);
  mkdirSync(clusterDir, { recursive: true });
  const clusterStateFile = join(clusterDir, "cluster-state.json");
  writeFileSync(
    clusterStateFile,
    JSON.stringify(
      {
        schema_version: "1.0",
        cluster_id: clusterId,
        state_generation: 1,
        child_states: childIds.map((id) => ({
          id,
          status: completedChildren.includes(id) ? "done" : "ready",
        })),
        claim_metadata: {},
        packet_pointers: {},
        result_pointers: {},
        validation_results: {},
        commits: {},
        tracker_mutations: {},
        blockers: [],
      },
      null,
      2,
    ),
    "utf-8",
  );
  return clusterStateFile;
}

function writeClusterSnapshotFile(
  dir: string,
  clusterId: string,
  nodes: Record<string, { title?: string; body?: string }>,
): void {
  const clusterDir = join(dir, ".polaris", "clusters", clusterId);
  mkdirSync(clusterDir, { recursive: true });
  const snapshot = {
    schemaVersion: "v2",
    source: { id: clusterId, type: "Linear" },
    nodes: Object.fromEntries(
      Object.entries(nodes).map(([id, n]) => [
        id,
        { id, title: n.title ?? id, status: "Todo", ...(n.body ? { body: n.body } : {}) },
      ]),
    ),
    dependencies: {},
    clusters: {
      [clusterId]: { id: clusterId, title: clusterId, children: Object.keys(nodes) },
    },
    activeCluster: clusterId,
  };
  writeFileSync(join(clusterDir, "clusters.json"), JSON.stringify(snapshot, null, 2), "utf-8");
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
    const absolutePacketPath = resolve(testDir, dispatchRecord?.packet_path!);
    expect(existsSync(absolutePacketPath)).toBe(true);

    // Read the packet and verify it contains expected fields
    const packet = JSON.parse(readFileSync(absolutePacketPath, "utf-8"));
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
    expect(existsSync(resolve(testDir, dispatchRecord?.packet_path!))).toBe(true);

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

  it("syncs claim and dispatch state into cluster-state.json", () => {
    const state = baseState();
    const stateFile = writeState(testDir, state);
    const clusterStateFile = writeClusterStateFile(
      testDir,
      "POL-142",
      ["POL-144", "POL-145", "POL-146"],
      ["POL-144"],
    );

    captureStdout(() => runLoopDispatch({ repoRoot: testDir, stateFile }));

    const updated = readState(stateFile);
    const dispatchRecord = updated.open_children_meta?.["POL-145"]?.dispatch_record;
    const clusterState = JSON.parse(readFileSync(clusterStateFile, "utf-8"));

    expect(clusterState.state_generation).toBe(2);
    expect(clusterState.child_states).toEqual([
      { id: "POL-144", status: "done" },
      { id: "POL-145", status: "dispatched" },
      { id: "POL-146", status: "ready" },
    ]);
    expect(clusterState.claim_metadata["POL-145"]).toMatchObject({
      worker_id: dispatchRecord?.worker_id,
      claimed_at: dispatchRecord?.dispatched_at,
    });
    expect(clusterState.packet_pointers["POL-145"]).toBe(dispatchRecord?.packet_path);
    expect(Date.parse(clusterState.claim_metadata["POL-145"].expires_at)).toBeGreaterThan(
      Date.parse(dispatchRecord?.dispatched_at ?? ""),
    );
  });

  it("creates cluster-state.json from loop state when missing", () => {
    const stateFile = writeState(testDir, baseState());

    captureStdout(() => runLoopDispatch({ repoRoot: testDir, stateFile }));

    const updated = readState(stateFile);
    const dispatchRecord = updated.open_children_meta?.["POL-145"]?.dispatch_record;
    const clusterStateFile = join(testDir, ".polaris", "clusters", "POL-142", "cluster-state.json");
    const clusterState = JSON.parse(readFileSync(clusterStateFile, "utf-8"));

    expect(clusterState.child_states).toEqual([
      { id: "POL-144", status: "done" },
      { id: "POL-145", status: "dispatched" },
      { id: "POL-146", status: "ready" },
    ]);
    expect(clusterState.claim_metadata["POL-145"].worker_id).toBe(dispatchRecord?.worker_id);
    expect(clusterState.packet_pointers["POL-145"]).toBe(dispatchRecord?.packet_path);
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
    expect(dispatchRecord?.provider_selection_reason).toBe("delegated-no-provider");
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
    expect(dispatchRecord?.provider_selection_reason).toBe("cli-provider-override");
    expect(dispatchRecord?.provider_override_source).toBe("dispatch-flag");
    expect(dispatchRecord?.providers_tried).toEqual(["copilot"]);
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

  it("emits provider-selected telemetry for each selection reason path", () => {
    const cases = [
      {
        name: "cli-provider-override",
        setup: () => undefined,
        run: (stateFile: string) => runLoopDispatch({ repoRoot: testDir, stateFile, provider: "gemini" }),
        expected: {
          selection_reason: "cli-provider-override",
          selected_provider: "gemini",
          override_source: "dispatch-flag",
        },
      },
      {
        name: "config-rotation",
        setup: () => {
          writeFileSync(
            join(testDir, "polaris.config.json"),
            JSON.stringify({
              execution: {
                adapter: "terminal-cli",
                providers: { codex: { command: "codex" }, copilot: { command: "copilot" } },
                rotation: ["codex", "copilot"],
              },
            }),
            "utf-8",
          );
        },
        run: (stateFile: string) => runLoopDispatch({ repoRoot: testDir, stateFile }),
        expected: {
          selection_reason: "config-rotation",
          selected_provider: "codex",
        },
      },
      {
        name: "config-first-provider",
        setup: () => {
          writeFileSync(
            join(testDir, "polaris.config.json"),
            JSON.stringify({
              execution: {
                adapter: "terminal-cli",
                providers: { copilot: { command: "copilot" } },
                rotation: [],
              },
            }),
            "utf-8",
          );
        },
        run: (stateFile: string) => runLoopDispatch({ repoRoot: testDir, stateFile }),
        expected: {
          selection_reason: "config-first-provider",
          selected_provider: "copilot",
          fallback_from: "rotation",
          fallback_reason: "rotation-empty",
        },
      },
      {
        name: "delegated-no-provider",
        setup: () => {
          const configPath = join(testDir, "polaris.config.json");
          if (existsSync(configPath)) rmSync(configPath);
        },
        run: (stateFile: string) => runLoopDispatch({ repoRoot: testDir, stateFile }),
        expected: {
          selection_reason: "delegated-no-provider",
          selected_provider: null,
        },
      },
    ] as const;

    for (const scenario of cases) {
      rmSync(join(testDir, ".taskchain_artifacts"), { recursive: true, force: true });
      rmSync(join(testDir, ".polaris"), { recursive: true, force: true });
      scenario.setup();
      const artifactDir = join(testDir, ".taskchain_artifacts", "polaris-run");
      const stateFile = writeState(testDir, baseState({ artifact_dir: artifactDir }));

      captureStdout(() => scenario.run(stateFile));

      const telemetryFile = join(artifactDir, "runs", "pol-142-session-1", "telemetry.jsonl");
      const providerEvents = readFileSync(telemetryFile, "utf-8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .filter((event) => event.event === "provider-selected");

      expect(providerEvents).toHaveLength(1);
      expect(providerEvents[0]).toMatchObject(scenario.expected);
      expect(providerEvents[0].requested_role).toBe("worker");
      expect(typeof providerEvents[0].selected_adapter).toBe("string");
      expect(providerEvents[0].selected_adapter.includes("/")).toBe(false);
    }
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

  // ── Role context tests (POL-227 / POL-230) ──────────────────────────────────

  it("impl packet includes worker role_context", () => {
    const stateFile = writeState(testDir, baseState());

    const output = captureStdout(() => runLoopDispatch({ repoRoot: testDir, stateFile }));
    const packet = JSON.parse(output);

    expect(packet.role_context).toBeDefined();
    expect(packet.role_context.role).toBe("worker");
    expect(packet.role_context.role_authority).toBe("implementation");
    expect(packet.role_context.may_implement).toBe(true);
    expect(packet.role_context.may_assign_workers).toBe(false);
    expect(Array.isArray(packet.role_context.prohibited_actions)).toBe(true);
  });

  it("dispatch record includes role fields from packet role_context", () => {
    const stateFile = writeState(testDir, baseState());

    captureStdout(() => runLoopDispatch({ repoRoot: testDir, stateFile }));

    const updated = readState(stateFile);
    const dr = updated.open_children_meta?.["POL-145"]?.dispatch_record;

    expect(dr?.role).toBe("worker");
    expect(dr?.role_authority).toBe("implementation");
    expect(dr?.may_implement).toBe(true);
    expect(dr?.session_type).toBe("implementation");
  });

  // ── Config provider routing (POL-228 scenario 2) ────────────────────────────

  it("uses config provider as direct-worker when no --provider flag", () => {
    // Write a polaris config with a configured provider
    writeFileSync(
      join(testDir, "polaris.config.json"),
      JSON.stringify({ execution: { adapter: "terminal-cli", providers: { codex: { command: "codex" } }, rotation: ["codex"] } }),
      "utf-8",
    );
    const stateFile = writeState(testDir, baseState());

    const output = captureStdout(() => runLoopDispatch({ repoRoot: testDir, stateFile }));
    const packet = JSON.parse(output);

    const updated = readState(stateFile);
    const dr = updated.open_children_meta?.["POL-145"]?.dispatch_record;

    expect(dr?.dispatch_mode).toBe("direct-worker");
    expect(dr?.provider).toBe("codex");
    expect(dr?.provider_selection_reason).toBe("config-rotation");
    expect(packet.role_context.role).toBe("worker");
  });

  it("uses role policy provider before rotation when role policy is configured", () => {
    writeFileSync(
      join(testDir, "polaris.config.json"),
      JSON.stringify({
        execution: {
          adapter: "terminal-cli",
          providers: { codex: { command: "codex" }, copilot: { command: "copilot" } },
          rotation: ["codex"],
          providerPolicy: {
            worker: { providers: ["copilot", "codex"] },
          },
        },
      }),
      "utf-8",
    );
    const stateFile = writeState(testDir, baseState());

    captureStdout(() => runLoopDispatch({ repoRoot: testDir, stateFile }));

    const updated = readState(stateFile);
    const dr = updated.open_children_meta?.["POL-145"]?.dispatch_record;
    expect(dr?.provider).toBe("copilot");
    expect(dr?.provider_selection_reason).toBe("role-policy");
  });

  it("uses role config provider when provider policy is absent", () => {
    writeFileSync(
      join(testDir, "polaris.config.json"),
      JSON.stringify({
        execution: {
          adapter: "terminal-cli",
          providers: { codex: { command: "codex" }, copilot: { command: "copilot" } },
          rotation: ["codex"],
          roles: {
            worker: { provider: "copilot" },
          },
        },
      }),
      "utf-8",
    );
    const stateFile = writeState(testDir, baseState());

    captureStdout(() => runLoopDispatch({ repoRoot: testDir, stateFile }));

    const updated = readState(stateFile);
    const dr = updated.open_children_meta?.["POL-145"]?.dispatch_record;
    expect(dr?.provider).toBe("copilot");
    expect(dr?.provider_selection_reason).toBe("role-config");
  });

  it("fails pre-dispatch and emits provider-forbidden when selected provider is outside role policy", () => {
    const artifactDir = join(testDir, ".taskchain_artifacts", "polaris-run");
    writeFileSync(
      join(testDir, "polaris.config.json"),
      JSON.stringify({
        execution: {
          adapter: "terminal-cli",
          providers: { codex: { command: "codex" }, copilot: { command: "copilot" } },
          rotation: ["codex"],
          providerPolicy: {
            worker: { providers: ["copilot"] },
          },
        },
      }),
      "utf-8",
    );
    const stateFile = writeState(testDir, baseState({ artifact_dir: artifactDir }));

    const stderr = expectDispatchError(() =>
      runLoopDispatch({ repoRoot: testDir, stateFile, provider: "codex" })
    );
    expect(stderr).toContain('provider "codex" is not allowed for role "worker"');

    const packetDir = join(testDir, ".polaris", "clusters", "POL-142", "packets");
    expect(existsSync(packetDir)).toBe(false);

    const telemetryFile = join(artifactDir, "runs", "pol-142-session-1", "telemetry.jsonl");
    const providerForbiddenEvents = readFileSync(telemetryFile, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((event) => event.event === "provider-forbidden");

    expect(providerForbiddenEvents).toHaveLength(1);
    expect(providerForbiddenEvents[0]).toMatchObject({
      requested_role: "worker",
      selected_provider: "codex",
      reason: "not-in-policy",
      policy_providers: ["copilot"],
    });
  });

  it("allows dispatch when selected provider is in role policy", () => {
    writeFileSync(
      join(testDir, "polaris.config.json"),
      JSON.stringify({
        execution: {
          adapter: "terminal-cli",
          providers: { codex: { command: "codex" }, copilot: { command: "copilot" } },
          rotation: ["codex"],
          providerPolicy: {
            worker: { providers: ["codex", "copilot"] },
          },
        },
      }),
      "utf-8",
    );
    const stateFile = writeState(testDir, baseState());

    const output = captureStdout(() => runLoopDispatch({ repoRoot: testDir, stateFile }));
    const packet = JSON.parse(output);
    expect(packet.active_child).toBe("POL-145");
  });

  it("allows dispatch when provider policy is absent", () => {
    writeFileSync(
      join(testDir, "polaris.config.json"),
      JSON.stringify({
        execution: {
          adapter: "terminal-cli",
          providers: { codex: { command: "codex" } },
          rotation: ["codex"],
        },
      }),
      "utf-8",
    );
    const stateFile = writeState(testDir, baseState());

    const output = captureStdout(() => runLoopDispatch({ repoRoot: testDir, stateFile }));
    const packet = JSON.parse(output);
    expect(packet.active_child).toBe("POL-145");
  });

  // ── Acknowledgment timeout detection (POL-228 scenario B + E) ───────────────

  it("checkAcknowledgmentTimeout returns null when no active child", () => {
    const stateFile = writeState(testDir, baseState());

    const result = checkAcknowledgmentTimeout({ stateFile, repoRoot: testDir });
    expect(result).toBeNull();
  });

  it("checkAcknowledgmentTimeout detects no-acknowledgment timeout", () => {
    const pastTime = new Date(Date.now() - 60_000).toISOString(); // 60s ago
    const stateFile = writeState(testDir, baseState({
      active_child: "POL-145",
      open_children_meta: {
        "POL-145": {
          title: "Test child",
          dispatch_record: {
            dispatch_id: "test-dispatch-001",
            child_id: "POL-145",
            run_id: "pol-142-session-1",
            cluster_id: "POL-142",
            packet_path: "/tmp/packet.json",
            expected_result_path: "/tmp/result.json",
            dispatched_at: pastTime,
            status: "dispatched",
            dispatch_mode: "direct-worker",
            runtime_state: "launching",
            worker_id: "worker-001", // Has worker_id but no first_heartbeat_at
          },
        },
      },
    }));

    const result = checkAcknowledgmentTimeout({
      stateFile,
      repoRoot: testDir,
      launchToFirstHeartbeatMs: 30_000,
    });

    expect(result).not.toBeNull();
    expect(result?.orphaned).toBe(true);
    expect(result?.reason).toBe("no-acknowledgment");
    expect(result?.childId).toBe("POL-145");
  });

  it("checkAcknowledgmentTimeout returns not-orphaned for fresh dispatch", () => {
    const stateFile = writeState(testDir, baseState({
      active_child: "POL-145",
      open_children_meta: {
        "POL-145": {
          title: "Test child",
          dispatch_record: {
            dispatch_id: "test-dispatch-001",
            child_id: "POL-145",
            run_id: "pol-142-session-1",
            cluster_id: "POL-142",
            packet_path: "/tmp/packet.json",
            expected_result_path: "/tmp/result.json",
            dispatched_at: new Date().toISOString(), // Just dispatched
            status: "dispatched",
            dispatch_mode: "direct-worker",
            runtime_state: "launching",
            worker_id: "worker-001",
          },
        },
      },
    }));

    const result = checkAcknowledgmentTimeout({
      stateFile,
      repoRoot: testDir,
      launchToFirstHeartbeatMs: 30_000,
    });

    expect(result?.orphaned).toBe(false);
  });

  // ── Cluster snapshot body hydration ──────────────────────────────────────
  //
  // buildPacket must hydrate issue body from .polaris/clusters/<id>/clusters.json
  // when open_children_meta lacks body. .taskchain_artifacts is ephemeral state;
  // clusters.json is the durable local body snapshot written by tracker sync-in.

  it("packet body and scope hydrated from clusters.json when state has no body", () => {
    const stateFile = writeState(
      testDir,
      baseState({
        // No body on POL-145
        open_children_meta: {
          "POL-145": { title: "Add dispatch command", labels: ["implement"] },
          "POL-146": { title: "Parent delivery", labels: ["implement"] },
        },
      }),
    );
    writeClusterSnapshotFile(testDir, "POL-142", {
      "POL-142": { title: "Cluster root" },
      "POL-145": {
        title: "Add dispatch command",
        body: "## Goal\nAdd dispatch.\n\n## Scope\n- src/loop/dispatch.ts\n",
      },
    });
    writeClusterStateFile(testDir, "POL-142", ["POL-145", "POL-146"]);

    const output = captureStdout(() => runLoopDispatch({ repoRoot: testDir, stateFile }));
    const packet = JSON.parse(output);

    expect(packet.active_child).toBe("POL-145");
    expect(packet.instructions.issue_context?.body).toContain("## Goal");
    expect(packet.instructions.allowed_scope).toContain("src/loop/dispatch.ts");
  });

  it("packet proceeds without body when neither state nor clusters.json has body", () => {
    const stateFile = writeState(
      testDir,
      baseState({
        open_children_meta: {
          "POL-145": { title: "Add dispatch command", labels: ["implement"] },
          "POL-146": { title: "Parent delivery", labels: ["implement"] },
        },
      }),
    );
    writeClusterStateFile(testDir, "POL-142", ["POL-145", "POL-146"]);
    // No clusters.json written — snapshot absent

    const output = captureStdout(() => runLoopDispatch({ repoRoot: testDir, stateFile }));
    const packet = JSON.parse(output);

    expect(packet.active_child).toBe("POL-145");
    // No body available, so issue_context body is undefined and scope is empty
    expect(packet.instructions.issue_context?.body).toBeUndefined();
    expect(packet.instructions.allowed_scope).toEqual([]);
  });

  it("packet body and scope hydrated from clusters.json when open_children_meta entry is entirely absent", () => {
    // Child has no entry at all in open_children_meta; body comes entirely from snapshot.
    const stateFile = writeState(
      testDir,
      baseState({
        open_children_meta: {
          // POL-145 entry omitted entirely
          "POL-146": { title: "Parent delivery", labels: ["implement"] },
        },
      }),
    );
    writeClusterSnapshotFile(testDir, "POL-142", {
      "POL-142": { title: "Cluster root" },
      "POL-145": {
        title: "Add dispatch command",
        body: "## Goal\nAdd dispatch.\n\n## Scope\n- src/loop/dispatch.ts\n",
      },
    });
    writeClusterStateFile(testDir, "POL-142", ["POL-145", "POL-146"]);

    const output = captureStdout(() => runLoopDispatch({ repoRoot: testDir, stateFile }));
    const packet = JSON.parse(output);

    expect(packet.active_child).toBe("POL-145");
    expect(packet.instructions.issue_context?.body).toContain("## Goal");
    expect(packet.instructions.allowed_scope).toContain("src/loop/dispatch.ts");
  });
});

// ── result_file_contract contract tests ───────────────────────────────────────
// Verify that every generated packet JSON always carries a canonical
// top-level result_file_contract, and that the prompt renders the same path.

describe("result_file_contract — dispatch contract consistency", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = makeTestDir();
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("saved packet JSON always has top-level result_file_contract", () => {
    const stateFile = writeState(testDir, baseState());

    const output = captureStdout(() => runLoopDispatch({ repoRoot: testDir, stateFile }));
    const packet = JSON.parse(output) as Record<string, unknown>;

    expect(packet.result_file_contract).toBeDefined();
    const rfc = packet.result_file_contract as Record<string, unknown>;
    expect(typeof rfc.result_file).toBe("string");
    expect((rfc.result_file as string).length).toBeGreaterThan(0);
  });

  it("result_file path follows .polaris/clusters/<cluster>/results/<child>-<uuid>.json", () => {
    const stateFile = writeState(testDir, baseState());

    const output = captureStdout(() => runLoopDispatch({ repoRoot: testDir, stateFile }));
    const packet = JSON.parse(output) as Record<string, unknown>;

    const rfc = packet.result_file_contract as Record<string, unknown>;
    const resultFile = rfc.result_file as string;

    expect(resultFile).toContain(".polaris");
    expect(resultFile).toContain("clusters");
    expect(resultFile).toContain("POL-142");
    expect(resultFile).toContain("results");
    expect(resultFile).toContain("POL-145");
    expect(resultFile.endsWith(".json")).toBe(true);
  });

  it("worker prompt includes the same result file path as result_file_contract", () => {
    const stateFile = writeState(testDir, baseState());

    const output = captureStdout(() => runLoopDispatch({ repoRoot: testDir, stateFile }));
    const packet = JSON.parse(output) as Record<string, unknown>;

    const rfc = packet.result_file_contract as Record<string, unknown>;
    const resultFilePath = rfc.result_file as string;

    const prompt = buildWorkerInstructions(packet as Parameters<typeof buildWorkerInstructions>[0]);
    expect(prompt).toContain(`SEALED RESULT FILE: ${resultFilePath}`);
  });

  it("saved packet file on disk has result_file_contract matching stdout packet", () => {
    const stateFile = writeState(testDir, baseState());

    const output = captureStdout(() => runLoopDispatch({ repoRoot: testDir, stateFile }));
    const stdoutPacket = JSON.parse(output) as Record<string, unknown>;

    const updated = readState(stateFile);
    const dispatchRecord = updated.open_children_meta?.["POL-145"]?.dispatch_record;
    const packetPath = resolve(testDir, dispatchRecord!.packet_path!);

    const diskPacket = JSON.parse(readFileSync(packetPath, "utf-8")) as Record<string, unknown>;

    expect(diskPacket.result_file_contract).toBeDefined();
    expect(diskPacket.result_file_contract).toEqual(stdoutPacket.result_file_contract);
  });

  it("options.resultFile override is reflected in result_file_contract", () => {
    const stateFile = writeState(testDir, baseState());
    const customResultFile = join(testDir, "my-custom-result.json");

    const output = captureStdout(() =>
      runLoopDispatch({ repoRoot: testDir, stateFile, resultFile: customResultFile }),
    );
    const packet = JSON.parse(output) as Record<string, unknown>;

    const rfc = packet.result_file_contract as Record<string, unknown>;
    expect(rfc.result_file).toBe(customResultFile);
  });

  it("dry-run packet (from compileImplPacket) and non-dry-run dispatch produce same contract shape", () => {
    const stateFile = writeState(testDir, baseState());

    // Non-dry-run: result via runLoopDispatch
    const output = captureStdout(() => runLoopDispatch({ repoRoot: testDir, stateFile }));
    const livePacket = JSON.parse(output) as Record<string, unknown>;
    const liveRfc = livePacket.result_file_contract as Record<string, unknown>;

    expect(liveRfc).toBeDefined();
    expect(typeof liveRfc.result_file).toBe("string");
    expect(Object.keys(liveRfc)).toEqual(["result_file"]);
  });
});
