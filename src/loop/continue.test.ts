import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runLoopContinue } from "./continue.js";
import { validateState, readState } from "./checkpoint.js";

function makeTestDir(): string {
  const dir = join(tmpdir(), `polaris-loop-test-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  // Minimal git repo so branch detection doesn't blow up
  mkdirSync(join(dir, ".git"), { recursive: true });
  writeFileSync(join(dir, ".git/HEAD"), "ref: refs/heads/test-branch\n");
  return dir;
}

function writeState(dir: string, state: object): string {
  const stateFile = join(dir, ".polaris", "runs", "current-state.json");
  mkdirSync(join(dir, ".polaris", "runs"), { recursive: true });
  writeFileSync(stateFile, JSON.stringify(state, null, 2));
  return stateFile;
}

describe("validateState", () => {
  it("returns no errors for a valid state", () => {
    const state = {
      schema_version: "1.0",
      run_id: "test-run-1",
      cluster_id: "POL-5",
      active_child: "POL-23",
      completed_children: [],
      open_children: ["POL-24"],
      step_cursor: "03-execute-child",
      context_budget: { children_completed: 0 },
      status: "running",
      next_open_child: "POL-24",
    };
    expect(validateState(state)).toEqual([]);
  });

  it("returns errors for missing required fields", () => {
    const errors = validateState({ schema_version: "1.0" });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.includes("run_id"))).toBe(true);
  });

  it("rejects non-object input", () => {
    expect(validateState("string")).toContain("current-state.json must be a JSON object");
    expect(validateState(null)).toContain("current-state.json must be a JSON object");
  });
});

describe("runLoopContinue", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = makeTestDir();
    mkdirSync(join(testDir, ".polaris", "bootstrap"), { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("writes a bootstrap packet to .polaris/bootstrap/", () => {
    const state = {
      schema_version: "1.0",
      run_id: "pol-5-session-1",
      cluster_id: "POL-5",
      active_child: "POL-23",
      completed_children: [],
      open_children: ["POL-24", "POL-25", "POL-26", "POL-27"],
      step_cursor: "03-execute-child",
      context_budget: { children_completed: 0, max_children_per_session: 3 },
      status: "running",
      next_open_child: "POL-24",
    };
    const stateFile = writeState(testDir, state);

    // Capture stdout
    const stdoutChunks: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string | Buffer) => {
      stdoutChunks.push(chunk.toString());
      return true;
    };

    try {
      runLoopContinue({ stateFile, repoRoot: testDir });
    } finally {
      process.stdout.write = originalWrite;
    }

    // Bootstrap packet written to disk
    const bootstrapDir = join(testDir, ".polaris", "bootstrap");
    const packets = require("node:fs").readdirSync(bootstrapDir).filter((f: string) => f.endsWith(".json"));
    expect(packets.length).toBe(1);

    const packet = JSON.parse(
      readFileSync(join(bootstrapDir, packets[0]), "utf-8"),
    );
    expect(packet.run_id).toBe("pol-5-session-1");
    expect(packet.last_completed_child).toBe("POL-23");
    expect(packet.current_state_sha).toBeTruthy();
    expect(packet.open_children).toEqual(["POL-24", "POL-25", "POL-26", "POL-27"]);
  });

  it("updates current-state.json atomically (moves active_child to completed)", () => {
    const state = {
      schema_version: "1.0",
      run_id: "pol-5-session-1",
      cluster_id: "POL-5",
      active_child: "POL-23",
      completed_children: [],
      open_children: ["POL-24"],
      step_cursor: "03-execute-child",
      context_budget: { children_completed: 0, max_children_per_session: 3 },
      status: "running",
      next_open_child: "POL-24",
    };
    const stateFile = writeState(testDir, state);

    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = () => true;
    try {
      runLoopContinue({ stateFile, repoRoot: testDir });
    } finally {
      process.stdout.write = originalWrite;
    }

    const updated = readState(stateFile);
    expect(updated.completed_children).toContain("POL-23");
    expect(updated.active_child).toBe("");
    expect(updated.context_budget.children_completed).toBe(1);
  });

  it("appends a JSONL checkpoint event to telemetry file", () => {
    const state = {
      schema_version: "1.0",
      run_id: "pol-5-session-1",
      cluster_id: "POL-5",
      active_child: "POL-23",
      completed_children: [],
      open_children: ["POL-24"],
      step_cursor: "03-execute-child",
      context_budget: { children_completed: 0, max_children_per_session: 3 },
      status: "running",
      next_open_child: "POL-24",
      artifact_dir: join(testDir, ".taskchain_artifacts", "bootstrap-run"),
    };
    const stateFile = writeState(testDir, state);

    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = () => true;
    try {
      runLoopContinue({ stateFile, repoRoot: testDir });
    } finally {
      process.stdout.write = originalWrite;
    }

    const telemetryFile = join(
      testDir,
      ".taskchain_artifacts",
      "bootstrap-run",
      "runs",
      "pol-5-session-1",
      "telemetry.jsonl",
    );
    expect(existsSync(telemetryFile)).toBe(true);
    const line = JSON.parse(readFileSync(telemetryFile, "utf-8").trim());
    expect(line.event).toBe("loop-checkpoint");
    expect(line.run_id).toBe("pol-5-session-1");
    expect(line.child_id).toBe("POL-23");
  });

  it("emits bootstrap packet JSON to stdout", () => {
    const state = {
      schema_version: "1.0",
      run_id: "pol-5-session-1",
      cluster_id: "POL-5",
      active_child: "POL-23",
      completed_children: [],
      open_children: ["POL-24"],
      step_cursor: "03-execute-child",
      context_budget: { children_completed: 0, max_children_per_session: 3 },
      status: "running",
      next_open_child: "POL-24",
    };
    const stateFile = writeState(testDir, state);

    const stdoutChunks: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    const originalLog = console.log;
    const logs: string[] = [];
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    process.stdout.write = (chunk: string | Buffer) => {
      stdoutChunks.push(chunk.toString());
      return true;
    };
    try {
      runLoopContinue({ stateFile, repoRoot: testDir });
    } finally {
      process.stdout.write = originalWrite;
      console.log = originalLog;
    }

    const output = logs.join("\n");
    const packet = JSON.parse(output);
    expect(packet.current_state_sha).toBeTruthy();
    expect(packet.run_id).toBe("pol-5-session-1");
  });

  it("exits with error if state file missing", () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });
    expect(() =>
      runLoopContinue({
        stateFile: join(testDir, "nonexistent.json"),
        repoRoot: testDir,
      }),
    ).toThrow();
    exitSpy.mockRestore();
  });

  it("exits with error if state file is invalid", () => {
    const stateFile = join(testDir, ".polaris", "runs", "current-state.json");
    mkdirSync(join(testDir, ".polaris", "runs"), { recursive: true });
    writeFileSync(stateFile, JSON.stringify({ schema_version: "1.0" }));

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(() =>
      runLoopContinue({ stateFile, repoRoot: testDir }),
    ).toThrow();
    exitSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it("sets boundary_enforcement in packet when analyze→implement boundary fires", () => {
    const state = {
      schema_version: "1.0",
      run_id: "pol-5-session-1",
      cluster_id: "POL-5",
      active_child: "POL-23",
      session_type: "analyze",
      completed_children: [],
      open_children: ["POL-24"],
      open_children_meta: { "POL-24": { type: "implement" } },
      step_cursor: "03-execute-child",
      context_budget: { children_completed: 0, max_children_per_session: 3 },
      status: "running",
      next_open_child: "POL-24",
    };
    const stateFile = writeState(testDir, state);

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    try {
      runLoopContinue({ stateFile, repoRoot: testDir });
    } finally {
      console.log = origLog;
    }

    const packet = JSON.parse(logs.join("\n"));
    expect(packet.boundary_enforcement).toContain("analyze-session-ended");
  });

  it("emits boundary JSONL event to telemetry when boundary fires", () => {
    const state = {
      schema_version: "1.0",
      run_id: "pol-5-session-1",
      cluster_id: "POL-5",
      active_child: "POL-23",
      session_type: "analyze",
      completed_children: [],
      open_children: ["POL-24"],
      open_children_meta: { "POL-24": { type: "implement" } },
      step_cursor: "03-execute-child",
      context_budget: { children_completed: 0, max_children_per_session: 3 },
      status: "running",
      next_open_child: "POL-24",
      artifact_dir: join(testDir, ".taskchain_artifacts", "bootstrap-run"),
    };
    const stateFile = writeState(testDir, state);

    const origLog = console.log;
    console.log = () => {};
    try {
      runLoopContinue({ stateFile, repoRoot: testDir });
    } finally {
      console.log = origLog;
    }

    const telemetryFile = join(
      testDir,
      ".taskchain_artifacts",
      "bootstrap-run",
      "runs",
      "pol-5-session-1",
      "telemetry.jsonl",
    );
    const lines = readFileSync(telemetryFile, "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const boundaryEvent = lines.find((e) => e.event === "analyze-impl-boundary-enforced");
    expect(boundaryEvent).toBeTruthy();
    expect(boundaryEvent.stopped_before).toBe("POL-24");
  });

  it("does NOT set boundary_enforcement when both are implement type", () => {
    const state = {
      schema_version: "1.0",
      run_id: "pol-5-session-1",
      cluster_id: "POL-5",
      active_child: "POL-23",
      session_type: "implement",
      completed_children: [],
      open_children: ["POL-24"],
      open_children_meta: { "POL-24": { type: "implement" } },
      step_cursor: "03-execute-child",
      context_budget: { children_completed: 0, max_children_per_session: 3 },
      status: "running",
      next_open_child: "POL-24",
    };
    const stateFile = writeState(testDir, state);

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    try {
      runLoopContinue({ stateFile, repoRoot: testDir });
    } finally {
      console.log = origLog;
    }

    const packet = JSON.parse(logs.join("\n"));
    expect(packet.boundary_enforcement).toBeUndefined();
  });
});
