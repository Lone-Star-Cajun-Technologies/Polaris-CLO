import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { runLoopStatus, hasWorkerAcknowledged, canSessionBeAttached } from "./status.js";
import type { BootstrapPacket } from "./bootstrap-packet.js";

function makeTestDir(): string {
  const dir = join(tmpdir(), `polaris-status-test-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: dir });
  writeFileSync(join(dir, "README.md"), "test\n");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir });
  return dir;
}

function writeState(dir: string, state: object): string {
  const stateFile = join(dir, ".polaris", "runs", "current-state.json");
  mkdirSync(join(dir, ".polaris", "runs"), { recursive: true });
  writeFileSync(stateFile, JSON.stringify(state, null, 2));
  return stateFile;
}

function shaOf(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function writePacket(dir: string, packet: BootstrapPacket): void {
  const bootstrapDir = join(dir, ".polaris", "bootstrap");
  mkdirSync(bootstrapDir, { recursive: true });
  const filename = `${packet.run_id}-2026-01-01T00-00-00-000Z.json`;
  writeFileSync(join(bootstrapDir, filename), JSON.stringify(packet, null, 2));
}

const baseState = {
  schema_version: "1.0",
  run_id: "pol-5-session-1",
  cluster_id: "POL-5",
  session_type: "implement",
  active_child: "POL-26",
  completed_children: ["POL-23", "POL-24", "POL-25"],
  open_children: ["POL-26", "POL-27"],
  step_cursor: "implement-child",
  context_budget: { children_completed: 3, max_children_per_session: 3 },
  status: "running",
  next_open_child: "POL-26",
};

describe("runLoopStatus", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = makeTestDir();
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("prints human-readable status from state file", () => {
    const stateFile = writeState(testDir, baseState);
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    try {
      runLoopStatus({ repoRoot: testDir, stateFile });
    } finally {
      console.log = orig;
    }
    const output = logs.join("\n");
    expect(output).toContain("Polaris Loop Status");
    expect(output).toContain("pol-5-session-1");
    expect(output).toContain("POL-5");
    expect(output).toContain("implement");
    expect(output).toContain("POL-26");
    expect(output).toContain("POL-23, POL-24, POL-25");
    expect(output).toContain("Blocked:         none");
    expect(output).toContain("Runtime Artifacts:");
    expect(output).toContain(".polaris/clusters/POL-5/cluster-state.json (canonical; live execution authority)");
    expect(output).toContain(".polaris/runs/current-state.json (legacy; legacy/transitional current-state snapshot)");
  });

  it("emits JSON output with --json flag", () => {
    const stateFile = writeState(testDir, baseState);
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    try {
      runLoopStatus({ repoRoot: testDir, stateFile, json: true });
    } finally {
      console.log = orig;
    }
    const parsed = JSON.parse(logs.join("\n"));
    expect(parsed.run_id).toBe("pol-5-session-1");
    expect(parsed.completed_children).toEqual(["POL-23", "POL-24", "POL-25"]);
    expect(parsed.open_children).toEqual(["POL-26", "POL-27"]);
    expect(parsed.deadlock).toBe(false);
    expect(parsed.runtime_artifacts.cluster_state).toMatchObject({
      path: ".polaris/clusters/POL-5/cluster-state.json",
      classification: "canonical",
      role: "live execution authority",
      exists: false,
    });
    expect(parsed.runtime_artifacts.current_state).toMatchObject({
      path: ".polaris/runs/current-state.json",
      classification: "legacy",
    });
  });

  it("reports bootstrap packet as fresh when SHA matches", () => {
    const stateFile = writeState(testDir, baseState);
    const stateContent = JSON.stringify(baseState, null, 2);
    const sha = shaOf(stateContent);
    const packet: BootstrapPacket = {
      run_id: "pol-5-session-1",
      skill: "bootstrap-run",
      branch: "main",
      base_commit_sha: "abc123",
      last_completed_step: "checkpoint",
      last_completed_child: "POL-25",
      next_step: "03-execute-child",
      open_children: ["POL-26", "POL-27"],
      artifact_pointers: {
        current_state: stateFile,
        telemetry: "/tmp/telemetry.jsonl",
      },
      context_budget: { children_completed: 3, files_touched_total: 0, stop_threshold_remaining: 0 },
      current_state_sha: sha,
      resume_instructions: "Run polaris loop resume",
    };
    writePacket(testDir, packet);

    const logs: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    try {
      runLoopStatus({ repoRoot: testDir, stateFile });
    } finally {
      console.log = orig;
    }
    expect(logs.join("\n")).toContain("(fresh)");
    expect(logs.join("\n")).toContain("matches current-state.json ✓");
  });

  it("reports bootstrap packet as stale when SHA mismatches", () => {
    const stateFile = writeState(testDir, baseState);
    const packet: BootstrapPacket = {
      run_id: "pol-5-session-1",
      skill: "bootstrap-run",
      branch: "main",
      base_commit_sha: "abc123",
      last_completed_step: "checkpoint",
      last_completed_child: "POL-25",
      next_step: "03-execute-child",
      open_children: ["POL-26", "POL-27"],
      artifact_pointers: {
        current_state: stateFile,
        telemetry: "/tmp/telemetry.jsonl",
      },
      context_budget: { children_completed: 3, files_touched_total: 0, stop_threshold_remaining: 0 },
      current_state_sha: "wrongsha",
      resume_instructions: "Run polaris loop resume",
    };
    writePacket(testDir, packet);

    const logs: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    try {
      runLoopStatus({ repoRoot: testDir, stateFile });
    } finally {
      console.log = orig;
    }
    expect(logs.join("\n")).toContain("stale");
    expect(logs.join("\n")).toContain("MISMATCH");
  });

  it("detects deadlock when all open children are blocked", () => {
    const deadlockState = {
      ...baseState,
      open_children: ["POL-26"],
      blocked_children: ["POL-26"],
    };
    const stateFile = writeState(testDir, deadlockState);
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    try {
      runLoopStatus({ repoRoot: testDir, stateFile });
    } finally {
      console.log = orig;
    }
    expect(logs.join("\n")).toContain("DEADLOCK DETECTED");
    expect(logs.join("\n")).toContain("POL-26 — blocked");
    expect(logs.join("\n")).toContain("polaris loop resume");
  });

  it("reports no deadlock when only some children are blocked", () => {
    const partialBlockState = {
      ...baseState,
      open_children: ["POL-26", "POL-27"],
      blocked_children: ["POL-27"],
    };
    const stateFile = writeState(testDir, partialBlockState);
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    try {
      runLoopStatus({ repoRoot: testDir, stateFile });
    } finally {
      console.log = orig;
    }
    expect(logs.join("\n")).not.toContain("DEADLOCK DETECTED");
  });

  it("exits with error when state file is missing", () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() =>
        runLoopStatus({
          repoRoot: testDir,
          stateFile: join(testDir, "nonexistent.json"),
        }),
      ).toThrow();
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("cannot read state file"));
    } finally {
      exitSpy.mockRestore();
      errSpy.mockRestore();
    }
  });

  it("includes deadlock info in JSON output", () => {
    const deadlockState = {
      ...baseState,
      open_children: ["POL-26"],
      blocked_children: ["POL-26"],
    };
    const stateFile = writeState(testDir, deadlockState);
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    try {
      runLoopStatus({ repoRoot: testDir, stateFile, json: true });
    } finally {
      console.log = orig;
    }
    const parsed = JSON.parse(logs.join("\n"));
    expect(parsed.deadlock).toBe(true);
    expect(parsed.blocked_children).toEqual(["POL-26"]);
  });

  // ── REGRESSION TESTS: Status dispatch evidence ─────────────────────────────

  it("reports dispatch evidence in JSON output when dispatch_record exists", () => {
    const stateWithDispatch = {
      ...baseState,
      active_child: "POL-26",
      step_cursor: "dispatch",
      open_children_meta: {
        "POL-26": {
          title: "Test child",
          dispatch_record: {
            dispatch_id: "test-dispatch-123",
            child_id: "POL-26",
            run_id: "pol-5-session-1",
            cluster_id: "POL-5",
            packet_path: "/tmp/test/packet.json",
            expected_result_path: "/tmp/test/result.json",
            provider: "terminal-cli",
            dispatched_at: "2026-01-15T10:30:00.000Z",
            status: "dispatched",
          },
        },
      },
    };
    const stateFile = writeState(testDir, stateWithDispatch);
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    try {
      runLoopStatus({ repoRoot: testDir, stateFile, json: true });
    } finally {
      console.log = orig;
    }
    const parsed = JSON.parse(logs.join("\n"));
    expect(parsed.dispatch).toBeDefined();
    expect(parsed.dispatch.child_id).toBe("POL-26");
    expect(parsed.dispatch.dispatch_status).toBe("dispatched");
    expect(parsed.dispatch.packet_path).toContain("packet.json");
    expect(parsed.dispatch.expected_result_path).toContain("result.json");
    expect(parsed.dispatch.provider).toBe("terminal-cli");
    expect(parsed.dispatch.dispatched_at).toBe("2026-01-15T10:30:00.000Z");
    expect(parsed.dispatch.result_present).toBe(false); // Result file doesn't exist
  });

  it("reports dispatch evidence in human-readable output", () => {
    const stateWithDispatch = {
      ...baseState,
      active_child: "POL-26",
      step_cursor: "dispatch",
      open_children_meta: {
        "POL-26": {
          title: "Test child",
          dispatch_record: {
            dispatch_id: "test-dispatch-456",
            child_id: "POL-26",
            run_id: "pol-5-session-1",
            cluster_id: "POL-5",
            packet_path: join(testDir, ".polaris", "clusters", "POL-5", "packets", "POL-26-dispatch.json"),
            expected_result_path: join(testDir, ".polaris", "clusters", "POL-5", "results", "POL-26-dispatch.json"),
            dispatched_at: "2026-01-15T10:30:00.000Z",
            status: "dispatched",
          },
        },
      },
    };
    const stateFile = writeState(testDir, stateWithDispatch);
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    try {
      runLoopStatus({ repoRoot: testDir, stateFile });
    } finally {
      console.log = orig;
    }
    const output = logs.join("\n");
    expect(output).toContain("Dispatch Evidence:");
    expect(output).toContain("POL-26");
    expect(output).toContain("Mode:");
    expect(output).toContain("Runtime state:");
    expect(output).toContain("packets");
    expect(output).toContain("results");
    expect(output).toContain("✗ no"); // Result not present
  });

  it("reports result_present=true when result file exists", () => {
    // Create result file
    const resultDir = join(testDir, ".polaris", "clusters", "POL-5", "results");
    mkdirSync(resultDir, { recursive: true });
    const resultPath = join(resultDir, "POL-26-completed.json");
    writeFileSync(resultPath, JSON.stringify({ status: "success" }), "utf-8");

    const stateWithDispatch = {
      ...baseState,
      active_child: "POL-26",
      step_cursor: "checkpoint",
      open_children_meta: {
        "POL-26": {
          title: "Test child",
          dispatch_record: {
            dispatch_id: "test-dispatch-789",
            child_id: "POL-26",
            run_id: "pol-5-session-1",
            cluster_id: "POL-5",
            packet_path: join(testDir, ".polaris", "clusters", "POL-5", "packets", "POL-26-completed.json"),
            expected_result_path: resultPath,
            dispatched_at: "2026-01-15T10:30:00.000Z",
            status: "completed",
          },
        },
      },
    };
    const stateFile = writeState(testDir, stateWithDispatch);
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    try {
      runLoopStatus({ repoRoot: testDir, stateFile, json: true });
    } finally {
      console.log = orig;
    }
    const parsed = JSON.parse(logs.join("\n"));
    expect(parsed.dispatch.result_present).toBe(true);
  });

  it("warns when active_child set but no dispatch evidence found", () => {
    const stateWithActiveChild = {
      ...baseState,
      active_child: "POL-26",
      step_cursor: "dispatch",
      // No dispatch_record in open_children_meta
      open_children_meta: {},
    };
    const stateFile = writeState(testDir, stateWithActiveChild);
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    try {
      runLoopStatus({ repoRoot: testDir, stateFile });
    } finally {
      console.log = orig;
    }
    const output = logs.join("\n");
    expect(output).toContain("No dispatch evidence found for active child");
    expect(output).toContain("POL-26 is active but no packet/result artifacts exist");
  });

  it("derives runtime_state as delegated when dispatch_mode is delegated and runtime_state is undefined", () => {
    // This tests the case where old/existing data has dispatch_mode but no runtime_state
    const stateWithDispatchNoRuntimeState = {
      ...baseState,
      active_child: "POL-26",
      step_cursor: "dispatch",
      open_children_meta: {
        "POL-26": {
          title: "Test child",
          dispatch_record: {
            dispatch_id: "test-dispatch-123",
            child_id: "POL-26",
            run_id: "pol-5-session-1",
            cluster_id: "POL-5",
            packet_path: join(testDir, ".polaris", "clusters", "POL-5", "packets", "POL-26-no-state.json"),
            expected_result_path: join(testDir, ".polaris", "clusters", "POL-5", "results", "POL-26-no-state.json"),
            dispatched_at: "2026-01-15T10:30:00.000Z",
            status: "dispatched",
            dispatch_mode: "delegated",
            // Note: runtime_state is intentionally omitted
          },
        },
      },
    };
    const stateFile = writeState(testDir, stateWithDispatchNoRuntimeState);
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    try {
      runLoopStatus({ repoRoot: testDir, stateFile });
    } finally {
      console.log = orig;
    }
    const output = logs.join("\n");
    // Should show "delegated" not "unknown"
    expect(output).toContain("Mode:             delegated");
    expect(output).toContain("Runtime state:    delegated");
    expect(output).not.toContain("Runtime state:    unknown");
  });
});

// ── hasWorkerAcknowledged and canSessionBeAttached ─────────────────────────────

function makeStateWithDispatch(dispatchOverrides: Record<string, unknown> = {}) {
  return {
    schema_version: "1.0",
    run_id: "pol-5-session-1",
    cluster_id: "POL-5",
    session_type: "implement",
    active_child: "POL-26",
    completed_children: [],
    open_children: ["POL-26"],
    step_cursor: "dispatch",
    context_budget: { children_completed: 0, max_children_per_session: 3 },
    status: "running",
    next_open_child: "POL-26",
    open_children_meta: {
      "POL-26": {
        title: "Test child",
        dispatch_record: {
          dispatch_id: "test-dispatch-id",
          child_id: "POL-26",
          run_id: "pol-5-session-1",
          cluster_id: "POL-5",
          packet_path: "/tmp/packet.json",
          expected_result_path: "/tmp/result.json",
          dispatched_at: "2026-01-15T10:30:00.000Z",
          status: "dispatched",
          ...dispatchOverrides,
        },
      },
    },
  };
}

describe("hasWorkerAcknowledged", () => {
  it("returns false for unknown dispatch_id", () => {
    const state = makeStateWithDispatch({ runtime_state: "acknowledged" });
    expect(hasWorkerAcknowledged("unknown-id", state as ReturnType<typeof import("./checkpoint.js").readState>)).toBe(false);
  });

  it("returns true when runtime_state is acknowledged", () => {
    const state = makeStateWithDispatch({ runtime_state: "acknowledged" });
    expect(hasWorkerAcknowledged("test-dispatch-id", state as ReturnType<typeof import("./checkpoint.js").readState>)).toBe(true);
  });

  it("returns true when runtime_state is running", () => {
    const state = makeStateWithDispatch({ runtime_state: "running" });
    expect(hasWorkerAcknowledged("test-dispatch-id", state as ReturnType<typeof import("./checkpoint.js").readState>)).toBe(true);
  });

  it("returns true when runtime_state is blocked", () => {
    const state = makeStateWithDispatch({ runtime_state: "blocked" });
    expect(hasWorkerAcknowledged("test-dispatch-id", state as ReturnType<typeof import("./checkpoint.js").readState>)).toBe(true);
  });

  it("returns true when runtime_state is completed", () => {
    const state = makeStateWithDispatch({ runtime_state: "completed" });
    expect(hasWorkerAcknowledged("test-dispatch-id", state as ReturnType<typeof import("./checkpoint.js").readState>)).toBe(true);
  });

  it("returns true when runtime_state is failed", () => {
    const state = makeStateWithDispatch({ runtime_state: "failed" });
    expect(hasWorkerAcknowledged("test-dispatch-id", state as ReturnType<typeof import("./checkpoint.js").readState>)).toBe(true);
  });

  it("returns true when runtime_state is orphaned", () => {
    const state = makeStateWithDispatch({ runtime_state: "orphaned" });
    expect(hasWorkerAcknowledged("test-dispatch-id", state as ReturnType<typeof import("./checkpoint.js").readState>)).toBe(true);
  });

  it("returns false when runtime_state is launching (pre-acknowledged)", () => {
    const state = makeStateWithDispatch({ runtime_state: "launching" });
    expect(hasWorkerAcknowledged("test-dispatch-id", state as ReturnType<typeof import("./checkpoint.js").readState>)).toBe(false);
  });

  it("returns false when runtime_state is packet-created", () => {
    const state = makeStateWithDispatch({ runtime_state: "packet-created" });
    expect(hasWorkerAcknowledged("test-dispatch-id", state as ReturnType<typeof import("./checkpoint.js").readState>)).toBe(false);
  });

  it("returns false when no runtime_state set and no telemetry", () => {
    const state = makeStateWithDispatch({});
    expect(hasWorkerAcknowledged("test-dispatch-id", state as ReturnType<typeof import("./checkpoint.js").readState>)).toBe(false);
  });

  it("falls back to telemetry scan when runtime_state not acknowledged", () => {
    const dir = join(tmpdir(), `polaris-ack-test-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const telemetryFile = join(dir, "telemetry.jsonl");
    writeFileSync(telemetryFile, JSON.stringify({
      event: "worker-acknowledged",
      dispatch_id: "test-dispatch-id",
      run_id: "pol-5-session-1",
      child_id: "POL-26",
      worker_id: "w1",
      packet_sha: "abc123",
      timestamp: "2026-01-15T10:30:01.000Z",
    }) + "\n");

    const state = makeStateWithDispatch({ runtime_state: "launching" });
    try {
      expect(hasWorkerAcknowledged("test-dispatch-id", state as ReturnType<typeof import("./checkpoint.js").readState>, telemetryFile)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("telemetry fallback returns false when dispatch_id does not match", () => {
    const dir = join(tmpdir(), `polaris-ack-test-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const telemetryFile = join(dir, "telemetry.jsonl");
    writeFileSync(telemetryFile, JSON.stringify({
      event: "worker-acknowledged",
      dispatch_id: "other-dispatch",
      run_id: "pol-5-session-1",
      child_id: "POL-26",
      worker_id: "w1",
      packet_sha: "abc123",
      timestamp: "2026-01-15T10:30:01.000Z",
    }) + "\n");

    const state = makeStateWithDispatch({ runtime_state: "launching" });
    try {
      expect(hasWorkerAcknowledged("test-dispatch-id", state as ReturnType<typeof import("./checkpoint.js").readState>, telemetryFile)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("canSessionBeAttached", () => {
  it("returns false for unknown dispatch_id", () => {
    const state = makeStateWithDispatch({ attachment_capable: true, session_id: "sess-abc" });
    expect(canSessionBeAttached("unknown-id", state as ReturnType<typeof import("./checkpoint.js").readState>)).toBe(false);
  });

  it("returns true when attachment_capable=true and session_id is set", () => {
    const state = makeStateWithDispatch({ attachment_capable: true, session_id: "sess-abc" });
    expect(canSessionBeAttached("test-dispatch-id", state as ReturnType<typeof import("./checkpoint.js").readState>)).toBe(true);
  });

  it("returns false when attachment_capable=true but session_id is null", () => {
    const state = makeStateWithDispatch({ attachment_capable: true, session_id: null });
    expect(canSessionBeAttached("test-dispatch-id", state as ReturnType<typeof import("./checkpoint.js").readState>)).toBe(false);
  });

  it("returns false when attachment_capable=true but session_id is undefined", () => {
    const state = makeStateWithDispatch({ attachment_capable: true });
    expect(canSessionBeAttached("test-dispatch-id", state as ReturnType<typeof import("./checkpoint.js").readState>)).toBe(false);
  });

  it("returns false when attachment_capable=false and session_id is set", () => {
    const state = makeStateWithDispatch({ attachment_capable: false, session_id: "sess-abc" });
    expect(canSessionBeAttached("test-dispatch-id", state as ReturnType<typeof import("./checkpoint.js").readState>)).toBe(false);
  });

  it("returns false when attachment_capable is not set", () => {
    const state = makeStateWithDispatch({ session_id: "sess-abc" });
    expect(canSessionBeAttached("test-dispatch-id", state as ReturnType<typeof import("./checkpoint.js").readState>)).toBe(false);
  });
});

describe("JSON output includes worker_acknowledged and session_attachable", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = makeTestDir();
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("includes worker_acknowledged=true when runtime_state is acknowledged", () => {
    const stateWithDispatch = {
      ...baseState,
      open_children_meta: {
        "POL-26": {
          dispatch_record: {
            dispatch_id: "disp-001",
            child_id: "POL-26",
            run_id: "pol-5-session-1",
            cluster_id: "POL-5",
            packet_path: "/tmp/p.json",
            expected_result_path: "/tmp/r.json",
            dispatched_at: "2026-01-15T10:30:00.000Z",
            status: "dispatched",
            runtime_state: "acknowledged",
          },
        },
      },
    };
    const stateFile = writeState(testDir, stateWithDispatch);
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    try {
      runLoopStatus({ repoRoot: testDir, stateFile, json: true });
    } finally {
      console.log = orig;
    }
    const parsed = JSON.parse(logs.join("\n"));
    expect(parsed.dispatch.worker_acknowledged).toBe(true);
  });

  it("includes worker_acknowledged=false when runtime_state is launching", () => {
    const stateWithDispatch = {
      ...baseState,
      open_children_meta: {
        "POL-26": {
          dispatch_record: {
            dispatch_id: "disp-002",
            child_id: "POL-26",
            run_id: "pol-5-session-1",
            cluster_id: "POL-5",
            packet_path: "/tmp/p.json",
            expected_result_path: "/tmp/r.json",
            dispatched_at: "2026-01-15T10:30:00.000Z",
            status: "dispatched",
            runtime_state: "launching",
          },
        },
      },
    };
    const stateFile = writeState(testDir, stateWithDispatch);
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    try {
      runLoopStatus({ repoRoot: testDir, stateFile, json: true });
    } finally {
      console.log = orig;
    }
    const parsed = JSON.parse(logs.join("\n"));
    expect(parsed.dispatch.worker_acknowledged).toBe(false);
  });

  it("includes session_attachable=true when attachment_capable=true and session_id set", () => {
    const stateWithDispatch = {
      ...baseState,
      open_children_meta: {
        "POL-26": {
          dispatch_record: {
            dispatch_id: "disp-003",
            child_id: "POL-26",
            run_id: "pol-5-session-1",
            cluster_id: "POL-5",
            packet_path: "/tmp/p.json",
            expected_result_path: "/tmp/r.json",
            dispatched_at: "2026-01-15T10:30:00.000Z",
            status: "dispatched",
            runtime_state: "running",
            attachment_capable: true,
            session_id: "sess-xyz",
          },
        },
      },
    };
    const stateFile = writeState(testDir, stateWithDispatch);
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    try {
      runLoopStatus({ repoRoot: testDir, stateFile, json: true });
    } finally {
      console.log = orig;
    }
    const parsed = JSON.parse(logs.join("\n"));
    expect(parsed.dispatch.session_attachable).toBe(true);
  });

  it("includes session_attachable=false when attachment_capable=true but session_id is null", () => {
    const stateWithDispatch = {
      ...baseState,
      open_children_meta: {
        "POL-26": {
          dispatch_record: {
            dispatch_id: "disp-004",
            child_id: "POL-26",
            run_id: "pol-5-session-1",
            cluster_id: "POL-5",
            packet_path: "/tmp/p.json",
            expected_result_path: "/tmp/r.json",
            dispatched_at: "2026-01-15T10:30:00.000Z",
            status: "dispatched",
            runtime_state: "acknowledged",
            attachment_capable: true,
            session_id: null,
          },
        },
      },
    };
    const stateFile = writeState(testDir, stateWithDispatch);
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    try {
      runLoopStatus({ repoRoot: testDir, stateFile, json: true });
    } finally {
      console.log = orig;
    }
    const parsed = JSON.parse(logs.join("\n"));
    expect(parsed.dispatch.session_attachable).toBe(false);
  });
});
