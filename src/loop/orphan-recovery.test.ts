/**
 * Tests for orphan detection and child recovery workflow (POL-229).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkOrphans, type OrphanCheckOptions } from "./orphan-recovery.js";
import { createBootstrapSeal } from "./run-bootstrap.js";

function makeTestDir(): string {
  const dir = join(tmpdir(), `polaris-orphan-test-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeState(dir: string, state: object): string {
  const stateFile = join(dir, "current-state.json");
  writeFileSync(stateFile, JSON.stringify(state, null, 2), "utf-8");
  return stateFile;
}

function baseState(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    schema_version: "1.0",
    run_id: "run-orphan-001",
    cluster_id: "POL-100",
    session_type: "implement",
    branch: "test-branch",
    active_child: "",
    completed_children: [],
    open_children: ["POL-101"],
    open_children_meta: {},
    step_cursor: "dispatch",
    context_budget: { children_completed: 0, max_children_per_session: 3 },
    status: "running",
    next_open_child: "POL-101",
    dispatch_boundary: { dispatch_epoch: 1, continue_epoch: 0, last_dispatched_child: null },
    run_bootstrap_seal: createBootstrapSeal("run-orphan-001", "POL-100", ["POL-101"]),
    ...overrides,
  };
}

function telemetryEvents(dir: string): Array<Record<string, unknown>> {
  const runId = "run-orphan-001";
  const telemetryFile = join(dir, ".taskchain_artifacts", "polaris-run", "runs", runId, "telemetry.jsonl");
  if (!existsSync(telemetryFile)) return [];
  return readFileSync(telemetryFile, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("checkOrphans", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = makeTestDir();
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  function opts(extra: Partial<OrphanCheckOptions> = {}): OrphanCheckOptions {
    return {
      stateFile: join(testDir, "current-state.json"),
      repoRoot: testDir,
      timeouts: {
        launchTimeoutMs: 100,
        launchToFirstHeartbeatMs: 100,
        orphanTimeoutMs: 100,
        staleDispatchTimeoutMs: 100,
      },
      ...extra,
    };
  }

  it("returns zero detections when no active child", () => {
    writeState(testDir, baseState());
    const result = checkOrphans(opts());
    expect(result.detected).toHaveLength(0);
  });

  it("Scenario A: detects no-worker-assignment when worker_id missing after launch timeout", () => {
    const pastTime = new Date(Date.now() - 500).toISOString();
    writeState(testDir, baseState({
      active_child: "POL-101",
      open_children_meta: {
        "POL-101": {
          dispatch_record: {
            dispatch_id: "d-001",
            child_id: "POL-101",
            run_id: "run-orphan-001",
            cluster_id: "POL-100",
            packet_path: "/tmp/p.json",
            expected_result_path: "/tmp/r.json",
            dispatched_at: pastTime,
            status: "dispatched",
            runtime_state: "packet-created",
            // No worker_id
          },
        },
      },
    }));

    const result = checkOrphans(opts());

    expect(result.detected).toHaveLength(1);
    expect(result.detected[0].reason).toBe("no-worker-assignment");
    expect(result.detected[0].requiresApproval).toBe(false);

    const events = telemetryEvents(testDir);
    expect(events.some((e) => e["event"] === "child-recovery-initiated")).toBe(true);
    expect(events.some((e) => e["event"] === "child-orphaned")).toBe(true);
    expect(events.some((e) => e["event"] === "child-requeued")).toBe(true);
  });

  it("Scenario B: detects no-acknowledgment when worker_id present but no heartbeat", () => {
    const pastTime = new Date(Date.now() - 500).toISOString();
    writeState(testDir, baseState({
      active_child: "POL-101",
      open_children_meta: {
        "POL-101": {
          dispatch_record: {
            dispatch_id: "d-001",
            child_id: "POL-101",
            run_id: "run-orphan-001",
            cluster_id: "POL-100",
            packet_path: "/tmp/p.json",
            expected_result_path: "/tmp/r.json",
            dispatched_at: pastTime,
            status: "dispatched",
            runtime_state: "launching",
            worker_id: "w-001",
            // No first_heartbeat_at
          },
        },
      },
    }));

    const result = checkOrphans(opts());

    expect(result.detected).toHaveLength(1);
    expect(result.detected[0].reason).toBe("no-acknowledgment");

    const events = telemetryEvents(testDir);
    expect(events.some((e) => e["event"] === "child-recovery-initiated")).toBe(true);
    expect(events.some((e) => e["recovery_reason"] === "no-acknowledgment")).toBe(true);
  });

  it("Scenario C: detects no-heartbeat and requires approval", () => {
    const pastTime = new Date(Date.now() - 500).toISOString();
    writeState(testDir, baseState({
      active_child: "POL-101",
      open_children_meta: {
        "POL-101": {
          dispatch_record: {
            dispatch_id: "d-001",
            child_id: "POL-101",
            run_id: "run-orphan-001",
            cluster_id: "POL-100",
            packet_path: "/tmp/p.json",
            expected_result_path: join(testDir, "result-missing.json"), // does not exist
            dispatched_at: pastTime,
            status: "dispatched",
            runtime_state: "running",
            worker_id: "w-001",
            first_heartbeat_at: pastTime,
            last_heartbeat_at: pastTime, // old heartbeat
          },
        },
      },
    }));

    const result = checkOrphans(opts());

    expect(result.detected).toHaveLength(1);
    expect(result.detected[0].reason).toBe("no-heartbeat");
    expect(result.detected[0].requiresApproval).toBe(true);

    const events = telemetryEvents(testDir);
    expect(events.some((e) => e["event"] === "recovery-approval-requested")).toBe(true);
  });

  it("Scenario E: detects stale-dispatch and auto-requeues", () => {
    const pastTime = new Date(Date.now() - 500).toISOString();
    writeState(testDir, baseState({
      active_child: "POL-101",
      open_children_meta: {
        "POL-101": {
          dispatch_record: {
            dispatch_id: "d-001",
            child_id: "POL-101",
            run_id: "run-orphan-001",
            cluster_id: "POL-100",
            packet_path: "/tmp/p.json",
            expected_result_path: "/tmp/r.json",
            dispatched_at: pastTime,
            status: "dispatched",
            runtime_state: "packet-created",
            // no worker_id, old dispatch
          },
        },
      },
    }));

    // Use longer launchTimeout so Scenario A doesn't trigger first
    const result = checkOrphans({
      ...opts(),
      timeouts: {
        launchTimeoutMs: 600_000,   // long — won't trigger Scenario A
        launchToFirstHeartbeatMs: 100,
        orphanTimeoutMs: 100,
        staleDispatchTimeoutMs: 100,   // short — triggers Scenario E
      },
    });

    expect(result.detected).toHaveLength(1);
    expect(result.detected[0].reason).toBe("stale-dispatch");

    const events = telemetryEvents(testDir);
    expect(events.some((e) => e["event"] === "child-requeued")).toBe(true);
  });

  it("no detection when dispatch is fresh", () => {
    const nowTime = new Date().toISOString();
    writeState(testDir, baseState({
      active_child: "POL-101",
      open_children_meta: {
        "POL-101": {
          dispatch_record: {
            dispatch_id: "d-001",
            child_id: "POL-101",
            run_id: "run-orphan-001",
            cluster_id: "POL-100",
            packet_path: "/tmp/p.json",
            expected_result_path: "/tmp/r.json",
            dispatched_at: nowTime,
            status: "dispatched",
            runtime_state: "launching",
            worker_id: "w-001",
          },
        },
      },
    }));

    const result = checkOrphans({
      ...opts(),
      timeouts: {
        launchTimeoutMs: 60_000,
        launchToFirstHeartbeatMs: 60_000,
        orphanTimeoutMs: 600_000,
        staleDispatchTimeoutMs: 1_800_000,
      },
    });

    expect(result.detected).toHaveLength(0);
  });
});
