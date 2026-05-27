import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runLoopDispatch } from "./dispatch.js";
import { readState } from "./checkpoint.js";

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

    expect(stderr).toContain("active_child already set");
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
});
