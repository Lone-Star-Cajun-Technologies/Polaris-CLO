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

    expect(packet.schema_version).toBe("2.0");
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
    expect(packet.schema_version).toBe("2.0");
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
});
