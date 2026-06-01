import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { runLoopAbort } from "./abort.js";
import { runLoopDispatch } from "./dispatch.js";
import { createBootstrapSeal } from "./run-bootstrap.js";

function makeTestDir(): string {
  const dir = join(tmpdir(), `polaris-abort-test-${Date.now()}`);
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

const baseState = {
  schema_version: "1.0",
  run_id: "pol-5-session-1",
  cluster_id: "POL-5",
  session_type: "implement",
  active_child: "POL-26",
  completed_children: ["POL-23"],
  open_children: ["POL-26", "POL-27"],
  step_cursor: "implement-child",
  context_budget: { children_completed: 1, max_children_per_session: 3 },
  status: "running",
  next_open_child: "POL-26",
};

describe("runLoopAbort", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = makeTestDir();
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("writes blocked status and blocker record to current-state.json", () => {
    const stateFile = writeState(testDir, baseState);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    try {
      expect(() =>
        runLoopAbort({ reason: "test blocker", repoRoot: testDir, stateFile }),
      ).toThrow("process.exit called");
    } finally {
      exitSpy.mockRestore();
      vi.restoreAllMocks();
    }

    const saved = JSON.parse(readFileSync(stateFile, "utf-8"));
    expect(saved.status).toBe("blocked");
    expect(saved.blocker.reason).toBe("test blocker");
    expect(saved.blocker.child_id).toBe("POL-26");
    expect(saved.blocker.resolved).toBe(false);
    expect(saved.blocker.timestamp).toBeTruthy();
  });

  it("uses --child override for blocker child_id", () => {
    const stateFile = writeState(testDir, baseState);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    try {
      expect(() =>
        runLoopAbort({
          reason: "dependency not done",
          childId: "POL-27",
          repoRoot: testDir,
          stateFile,
        }),
      ).toThrow("process.exit called");
    } finally {
      exitSpy.mockRestore();
      vi.restoreAllMocks();
    }

    const saved = JSON.parse(readFileSync(stateFile, "utf-8"));
    expect(saved.blocker.child_id).toBe("POL-27");
  });

  it("appends loop-aborted JSONL event to telemetry file", () => {
    const artifactDir = join(testDir, ".taskchain_artifacts", "polaris-run");
    const telemetryFile = join(artifactDir, "runs", "pol-5-session-1", "telemetry.jsonl");
    const stateFile = writeState(testDir, baseState);

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    try {
      expect(() =>
        runLoopAbort({ reason: "test blocker", repoRoot: testDir, stateFile }),
      ).toThrow("process.exit called");
    } finally {
      exitSpy.mockRestore();
      vi.restoreAllMocks();
    }

    const lines = readFileSync(telemetryFile, "utf-8").trim().split("\n");
    const event = JSON.parse(lines[lines.length - 1]);
    expect(event.event).toBe("loop-aborted");
    expect(event.run_id).toBe("pol-5-session-1");
    expect(event.reason).toBe("test blocker");
  });

  it("appends run-blocked to the global ledger and creates it when absent", () => {
    const stateFile = writeState(testDir, { ...baseState, branch: "test-branch" });
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    try {
      expect(() =>
        runLoopAbort({ reason: "test blocker", repoRoot: testDir, stateFile }),
      ).toThrow("process.exit called");
    } finally {
      exitSpy.mockRestore();
      vi.restoreAllMocks();
    }

    const ledgerFile = join(testDir, ".polaris", "runs", "ledger.jsonl");
    expect(existsSync(ledgerFile)).toBe(true);
    const events = readFileSync(ledgerFile, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events[0]).toMatchObject({
      event: "run-blocked",
      run_id: "pol-5-session-1",
      run_type: "implement",
      cluster_id: "POL-5",
      issue_id: "POL-26",
      branch: "test-branch",
      status: "blocked",
      completed_children: ["POL-23"],
      open_children: ["POL-26", "POL-27"],
      next_child: "POL-26",
      last_commit: null,
      pr_url: null,
      blocker: {
        summary: "test blocker",
        unblock_condition: "Resolve blocker then run: polaris loop resume",
      },
    });
  });

  it("prints abort message to stderr and exits 1", () => {
    const stateFile = writeState(testDir, baseState);
    const stderrMessages: string[] = [];
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((msg) => {
        stderrMessages.push(String(msg));
        return true;
      });

    try {
      expect(() =>
        runLoopAbort({ reason: "blocked by missing dep", repoRoot: testDir, stateFile }),
      ).toThrow("process.exit called");
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(stderrMessages.some((m) => m.includes("Loop aborted"))).toBe(true);
      expect(stderrMessages.some((m) => m.includes("blocked by missing dep"))).toBe(true);
      expect(stderrMessages.some((m) => m.includes("polaris loop resume"))).toBe(true);
    } finally {
      exitSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });

  it("exits with error when state file is missing", () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    try {
      expect(() =>
        runLoopAbort({
          reason: "test",
          repoRoot: testDir,
          stateFile: join(testDir, "nonexistent.json"),
        }),
      ).toThrow("process.exit called");
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining("cannot read state file"),
      );
    } finally {
      exitSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });

  // ── Stale dispatch reset tests ─────────────────────────────────────────────

  const staleDispatchState = {
    schema_version: "1.0",
    run_id: "pol-100-session-1",
    cluster_id: "POL-100",
    session_type: "implement",
    branch: "feature-branch",
    active_child: "POL-281",
    completed_children: ["POL-280"],
    open_children: ["POL-281", "POL-282"],
    open_children_meta: {
      "POL-281": {
        title: "Fix bug",
        dispatch_record: {
          dispatch_id: "old-dispatch-abc",
          child_id: "POL-281",
          run_id: "pol-100-session-1",
          cluster_id: "POL-100",
          packet_path: ".polaris/clusters/POL-100/packets/POL-281-old-dispatch-abc.json",
          expected_result_path: ".polaris/clusters/POL-100/results/POL-281-old-dispatch-abc.json",
          dispatched_at: "2024-01-01T00:00:00.000Z",
          status: "dispatched",
          dispatch_mode: "direct-worker",
          runtime_state: "packet-created",
        },
      },
      "POL-282": { title: "Next task" },
    },
    step_cursor: "dispatch",
    context_budget: { children_completed: 1, max_children_per_session: 3 },
    status: "running",
    next_open_child: "POL-281",
    dispatch_boundary: {
      dispatch_epoch: 2,
      continue_epoch: 1,
      last_dispatched_child: "POL-281",
    },
    run_bootstrap_seal: createBootstrapSeal("pol-100-session-1", "POL-100", ["POL-281", "POL-282"]),
  };

  it("clears active_child and balances dispatch_boundary when stale dispatch has no result and no heartbeat", () => {
    const stateFile = writeState(testDir, staleDispatchState);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    try {
      expect(() =>
        runLoopAbort({ reason: "stale dispatch", repoRoot: testDir, stateFile }),
      ).toThrow("process.exit called");
    } finally {
      exitSpy.mockRestore();
      vi.restoreAllMocks();
    }

    const saved = JSON.parse(readFileSync(stateFile, "utf-8"));
    expect(saved.active_child).toBe("");
    expect(saved.step_cursor).toBeNull();
    expect(saved.dispatch_boundary.continue_epoch).toBe(saved.dispatch_boundary.dispatch_epoch);
    expect(saved.status).toBe("blocked");
    expect(saved.blocker.reason).toBe("stale dispatch");
    // Old dispatch record is marked failed, not deleted
    expect(saved.open_children_meta["POL-281"].dispatch_record.status).toBe("failed");
    expect(saved.open_children_meta["POL-281"].dispatch_record.runtime_state).toBe("failed");
    expect(saved.open_children_meta["POL-281"].dispatch_record.dispatch_id).toBe("old-dispatch-abc");
  });

  it("does not erase completed children when clearing a stale dispatch", () => {
    const stateFile = writeState(testDir, staleDispatchState);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    try {
      expect(() =>
        runLoopAbort({ reason: "stale dispatch", repoRoot: testDir, stateFile }),
      ).toThrow("process.exit called");
    } finally {
      exitSpy.mockRestore();
      vi.restoreAllMocks();
    }

    const saved = JSON.parse(readFileSync(stateFile, "utf-8"));
    expect(saved.completed_children).toContain("POL-280");
    expect(saved.open_children).toContain("POL-281");
    expect(saved.open_children).toContain("POL-282");
  });

  it("status after stale-dispatch abort shows no active child", () => {
    const stateFile = writeState(testDir, staleDispatchState);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    try {
      expect(() =>
        runLoopAbort({ reason: "stale dispatch", repoRoot: testDir, stateFile }),
      ).toThrow("process.exit called");
    } finally {
      exitSpy.mockRestore();
      vi.restoreAllMocks();
    }

    const saved = JSON.parse(readFileSync(stateFile, "utf-8"));
    expect(saved.active_child).toBe("");

    // Verify that the telemetry records both the stale-dispatch-aborted event
    // and the standard loop-aborted event.
    const artifactDir = join(testDir, ".taskchain_artifacts", "polaris-run");
    const telemetryFile = join(artifactDir, "runs", "pol-100-session-1", "telemetry.jsonl");
    const events = readFileSync(telemetryFile, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const staleEvent = events.find((e) => e.event === "stale-dispatch-aborted");
    expect(staleEvent).toBeDefined();
    expect(staleEvent.child_id).toBe("POL-281");
    expect(staleEvent.had_heartbeat).toBe(false);
    expect(staleEvent.had_result_file).toBe(false);
    expect(staleEvent.aborted_dispatch_id).toBe("old-dispatch-abc");
    const abortEvent = events.find((e) => e.event === "loop-aborted");
    expect(abortEvent).toBeDefined();
  });

  it("fresh dispatch after stale-dispatch abort creates a new packet and result contract", () => {
    // Write cluster state so dispatch can sync
    const clusterDir = join(testDir, ".polaris", "clusters", "POL-100");
    mkdirSync(clusterDir, { recursive: true });
    writeFileSync(
      join(clusterDir, "cluster-state.json"),
      JSON.stringify({
        schema_version: "1.0",
        cluster_id: "POL-100",
        state_generation: 1,
        child_states: [
          { id: "POL-280", status: "done" },
          { id: "POL-281", status: "ready" },
          { id: "POL-282", status: "ready" },
        ],
        claim_metadata: {},
        packet_pointers: {},
        result_pointers: {},
        validation_results: {},
        commits: {},
        tracker_mutations: {},
        blockers: [],
      }, null, 2),
    );

    const stateFile = writeState(testDir, staleDispatchState);

    // Step 1: abort clears the stale dispatch
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(() =>
        runLoopAbort({ reason: "stale dispatch", repoRoot: testDir, stateFile }),
      ).toThrow("process.exit called");
    } finally {
      exitSpy.mockRestore();
      vi.restoreAllMocks();
    }

    // Step 2: Simulate `loop resume` by clearing the blocked status
    const afterAbort = JSON.parse(readFileSync(stateFile, "utf-8"));
    expect(afterAbort.active_child).toBe("");
    const unblocked = { ...afterAbort, status: "running" };
    writeFileSync(stateFile, JSON.stringify(unblocked, null, 2));

    // Step 3: Fresh dispatch must succeed and use a new dispatch_id
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      runLoopDispatch({ stateFile, repoRoot: testDir });
    } finally {
      stdoutSpy.mockRestore();
      vi.restoreAllMocks();
    }

    const afterDispatch = JSON.parse(readFileSync(stateFile, "utf-8"));
    expect(afterDispatch.active_child).toBe("POL-281");
    const newDr = afterDispatch.open_children_meta["POL-281"].dispatch_record;
    expect(newDr).toBeDefined();
    expect(newDr.dispatch_id).not.toBe("old-dispatch-abc");
    expect(newDr.status).toBe("dispatched");
    // result contract path should differ from the stale one
    expect(newDr.expected_result_path).not.toBe(
      ".polaris/clusters/POL-100/results/POL-281-old-dispatch-abc.json",
    );
  });
});
