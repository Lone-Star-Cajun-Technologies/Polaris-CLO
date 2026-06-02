import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runLoopContinue } from "./continue.js";
import { validateState, readState } from "./checkpoint.js";
import { readClusterStateSync } from "../cluster-state/store.js";

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
    expect(packet.execution_adapter.mode).toBe("terminal-cli");
    expect(packet.execution_adapter.compact_bootstrap_state.child_id).toBe("POL-24");
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
    expect(updated.open_children).toEqual(["POL-24"]);
    expect(updated.context_budget.children_completed).toBe(1);
  });

  it("appends child-completed to the global ledger after updating current-state.json", () => {
    const state = {
      schema_version: "1.0",
      run_id: "pol-5-session-1",
      cluster_id: "POL-5",
      branch: "test-branch",
      active_child: "POL-23",
      completed_children: [],
      open_children: ["POL-23", "POL-24"],
      step_cursor: "03-execute-child",
      context_budget: { children_completed: 0, max_children_per_session: 3 },
      status: "running",
      next_open_child: "POL-23",
      last_commit: "abc1234",
    };
    const stateFile = writeState(testDir, state);

    const origLog = console.log;
    console.log = () => {};
    try {
      runLoopContinue({ stateFile, repoRoot: testDir });
    } finally {
      console.log = origLog;
    }

    const ledgerFile = join(testDir, ".polaris", "runs", "ledger.jsonl");
    expect(existsSync(ledgerFile)).toBe(true);
    const events = readFileSync(ledgerFile, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const event = events.find((entry) => entry.event === "child-completed");
    expect(event).toMatchObject({
      run_id: "pol-5-session-1",
      run_type: "implement",
      cluster_id: "POL-5",
      issue_id: "POL-23",
      branch: "test-branch",
      status: "running",
      completed_children: ["POL-23"],
      open_children: ["POL-24"],
      next_child: "POL-24",
      last_commit: "abc1234",
      pr_url: null,
      validation: { status: "complete" },
    });
    expect(readState(stateFile).completed_children).toEqual(["POL-23"]);
  });

  it("appends cluster-complete to the global ledger when no next child remains", () => {
    const state = {
      schema_version: "1.0",
      run_id: "pol-5-session-1",
      cluster_id: "POL-5",
      branch: "test-branch",
      active_child: "POL-23",
      completed_children: [],
      open_children: ["POL-23"],
      step_cursor: "03-execute-child",
      context_budget: { children_completed: 0, max_children_per_session: 3 },
      status: "running",
      next_open_child: "POL-23",
      last_commit: "abc1234",
    };
    const stateFile = writeState(testDir, state);

    const origLog = console.log;
    console.log = () => {};
    try {
      runLoopContinue({ stateFile, repoRoot: testDir });
    } finally {
      console.log = origLog;
    }

    const events = readFileSync(join(testDir, ".polaris", "runs", "ledger.jsonl"), "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const event = events.find((entry) => entry.event === "cluster-complete");
    expect(event).toMatchObject({
      run_id: "pol-5-session-1",
      run_type: "implement",
      cluster_id: "POL-5",
      issue_id: null,
      branch: "test-branch",
      status: "cluster-complete",
      completed_children: ["POL-23"],
      open_children: [],
      next_child: null,
      last_commit: "abc1234",
      pr_url: null,
    });
  });

  it("removes completed child from open_children before selecting next child", () => {
    const state = {
      schema_version: "1.0",
      run_id: "pol-5-session-1",
      cluster_id: "POL-5",
      active_child: "POL-23",
      completed_children: [],
      open_children: ["POL-23", "POL-24"],
      step_cursor: "03-execute-child",
      context_budget: { children_completed: 0, max_children_per_session: 3 },
      status: "running",
      next_open_child: "POL-23",
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

    const updated = readState(stateFile);
    const packet = JSON.parse(logs.join("\n"));
    expect(updated.completed_children).toEqual(["POL-23"]);
    expect(updated.open_children).toEqual(["POL-24"]);
    expect(updated.next_open_child).toBe("POL-24");
    expect(packet.open_children).toEqual(["POL-24"]);
    expect(packet.execution_adapter.compact_bootstrap_state.child_id).toBe("POL-24");
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
      artifact_dir: join(testDir, ".taskchain_artifacts", "polaris-run"),
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
      "polaris-run",
      "runs",
      "pol-5-session-1",
      "telemetry.jsonl",
    );
    expect(existsSync(telemetryFile)).toBe(true);
    const lines = readFileSync(telemetryFile, "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const line = lines.find((e) => e.event === "loop-checkpoint");
    expect(line).toBeTruthy();
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

  it("forwards allowAnalyzeChildren override into execution bootstrap state", () => {
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

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    try {
      runLoopContinue({ stateFile, repoRoot: testDir, allowAnalyzeChildren: true });
    } finally {
      console.log = origLog;
    }

    const packet = JSON.parse(logs.join("\n"));
    expect(packet.execution_adapter.compact_bootstrap_state.allow_analyze_children).toBe(true);
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
      artifact_dir: join(testDir, ".taskchain_artifacts", "polaris-run"),
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
      "polaris-run",
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

  it("blocks checkpoint when dispatch-boundary child has no result evidence", () => {
    const state = {
      schema_version: "1.0",
      run_id: "pol-5-session-1",
      cluster_id: "POL-5",
      active_child: "POL-23",
      completed_children: [],
      open_children: ["POL-23", "POL-24"],
      open_children_meta: {
        "POL-23": {
          result_file: join(testDir, ".polaris", "clusters", "POL-5", "results", "missing.json"),
        },
      },
      step_cursor: "dispatch",
      context_budget: { children_completed: 0, max_children_per_session: 3 },
      status: "running",
      next_open_child: "POL-23",
      dispatch_boundary: {
        dispatch_epoch: 1,
        continue_epoch: 0,
        last_dispatched_child: "POL-23",
      },
    };
    const stateFile = writeState(testDir, state);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });
    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() => runLoopContinue({ stateFile, repoRoot: testDir })).toThrow("process.exit called");

    exitSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it("allows checkpoint with dispatch-boundary when result evidence includes commit", () => {
    const clusterDir = join(testDir, ".polaris", "clusters", "POL-5");
    const resultFile = join(clusterDir, "results", "POL-23-sealed.json");
    mkdirSync(join(clusterDir, "results"), { recursive: true });
    writeFileSync(
      resultFile,
      JSON.stringify({
        run_id: "pol-5-session-1",
        child_id: "POL-23",
        status: "success",
        commit: "abc1234",
        validation: "ok",
      }),
    );
    writeFileSync(
      join(clusterDir, "cluster-state.json"),
      JSON.stringify({
        schema_version: "1.0",
        cluster_id: "POL-5",
        state_generation: 1,
        child_states: [],
        claim_metadata: {},
        packet_pointers: {},
        result_pointers: {},
        validation_results: {},
        commits: {},
        tracker_mutations: {},
        blockers: [],
      }),
    );
    const state = {
      schema_version: "1.0",
      run_id: "pol-5-session-1",
      cluster_id: "POL-5",
      active_child: "POL-23",
      completed_children: [],
      open_children: ["POL-23", "POL-24"],
      open_children_meta: {
        "POL-23": {
          result_file: resultFile,
        },
      },
      step_cursor: "dispatch",
      context_budget: { children_completed: 0, max_children_per_session: 3 },
      status: "running",
      next_open_child: "POL-23",
      dispatch_boundary: {
        dispatch_epoch: 1,
        continue_epoch: 0,
        last_dispatched_child: "POL-23",
      },
    };
    const stateFile = writeState(testDir, state);
    const origLog = console.log;
    console.log = () => {};
    try {
      runLoopContinue({ stateFile, repoRoot: testDir });
    } finally {
      console.log = origLog;
    }

    const updated = readState(stateFile);
    expect(updated.completed_children).toEqual(["POL-23"]);
    expect(updated.last_commit).toBe("abc1234");
  });

  it("bridges commit and validation_results into cluster-state.json after successful continue", () => {
    const clusterDir = join(testDir, ".polaris", "clusters", "POL-5");
    const resultFile = join(clusterDir, "results", "POL-23-sealed.json");
    mkdirSync(join(clusterDir, "results"), { recursive: true });
    writeFileSync(
      resultFile,
      JSON.stringify({
        child_id: "POL-23",
        status: "done",
        commit: "deadbeef1234",
        validation: { passed: ["npm test", "npm run build"] },
      }),
    );
    // Minimal cluster-state.json (must exist for bridge to write)
    writeFileSync(
      join(clusterDir, "cluster-state.json"),
      JSON.stringify({
        schema_version: "1.0",
        cluster_id: "POL-5",
        state_generation: 1,
        child_states: [{ id: "POL-23", status: "dispatched" }],
        claim_metadata: {},
        packet_pointers: {},
        result_pointers: {},
        validation_results: {},
        commits: {},
        tracker_mutations: {},
        blockers: [],
      }),
    );
    const state = {
      schema_version: "1.0",
      run_id: "pol-5-session-1",
      cluster_id: "POL-5",
      active_child: "POL-23",
      completed_children: [],
      open_children: ["POL-23", "POL-24"],
      open_children_meta: {
        "POL-23": { result_file: resultFile },
      },
      step_cursor: "dispatch",
      context_budget: { children_completed: 0, max_children_per_session: 3 },
      status: "running",
      next_open_child: "POL-23",
      dispatch_boundary: { dispatch_epoch: 1, continue_epoch: 0, last_dispatched_child: "POL-23" },
    };
    const stateFile = writeState(testDir, state);
    const origLog = console.log;
    console.log = () => {};
    try {
      runLoopContinue({ stateFile, repoRoot: testDir });
    } finally {
      console.log = origLog;
    }

    const cs = readClusterStateSync("POL-5", testDir);
    expect(cs).not.toBeNull();
    expect(cs!.commits["POL-23"]).toBe("deadbeef1234");
    expect(cs!.result_pointers["POL-23"]).toBe(resultFile);
    expect(cs!.validation_results["POL-23"]).toMatchObject({ passed: true });
    const childState = cs!.child_states.find((c) => c.id === "POL-23");
    expect(childState?.status).toBe("done");
    expect(childState?.commit).toBe("deadbeef1234");
  });

  it("writes completed_children_results into current-state.json after continue with evidence", () => {
    const clusterDir = join(testDir, ".polaris", "clusters", "POL-5");
    const resultFile = join(clusterDir, "results", "POL-23-sealed.json");
    mkdirSync(join(clusterDir, "results"), { recursive: true });
    writeFileSync(
      resultFile,
      JSON.stringify({
        child_id: "POL-23",
        status: "done",
        commit: "deadbeef1234",
        validation: "passed",
      }),
    );
    writeFileSync(
      join(clusterDir, "cluster-state.json"),
      JSON.stringify({
        schema_version: "1.0",
        cluster_id: "POL-5",
        state_generation: 1,
        child_states: [],
        claim_metadata: {},
        packet_pointers: {},
        result_pointers: {},
        validation_results: {},
        commits: {},
        tracker_mutations: {},
        blockers: [],
      }),
    );
    const state = {
      schema_version: "1.0",
      run_id: "pol-5-session-1",
      cluster_id: "POL-5",
      active_child: "POL-23",
      completed_children: [],
      open_children: ["POL-23", "POL-24"],
      open_children_meta: { "POL-23": { result_file: resultFile } },
      step_cursor: "dispatch",
      context_budget: { children_completed: 0, max_children_per_session: 3 },
      status: "running",
      next_open_child: "POL-23",
      dispatch_boundary: { dispatch_epoch: 1, continue_epoch: 0, last_dispatched_child: "POL-23" },
    };
    const stateFile = writeState(testDir, state);
    const origLog = console.log;
    console.log = () => {};
    try {
      runLoopContinue({ stateFile, repoRoot: testDir });
    } finally {
      console.log = origLog;
    }

    const updated = readState(stateFile);
    expect(updated.completed_children_results?.["POL-23"]).toMatchObject({
      status: "done",
      validation: "passed",
      commit: "deadbeef1234",
      next_recommended_action: "continue",
    });
  });

  it("fails continue when result file contains a non-hex placeholder commit", () => {
    const clusterDir = join(testDir, ".polaris", "clusters", "POL-5");
    const resultFile = join(clusterDir, "results", "POL-23-placeholder.json");
    mkdirSync(join(clusterDir, "results"), { recursive: true });
    writeFileSync(
      resultFile,
      JSON.stringify({
        child_id: "POL-23",
        status: "done",
        commit: "pending-single-commit",
        validation: "passed",
      }),
    );
    const state = {
      schema_version: "1.0",
      run_id: "pol-5-session-1",
      cluster_id: "POL-5",
      active_child: "POL-23",
      completed_children: [],
      open_children: ["POL-23", "POL-24"],
      open_children_meta: { "POL-23": { result_file: resultFile } },
      step_cursor: "dispatch",
      context_budget: { children_completed: 0, max_children_per_session: 3 },
      status: "running",
      next_open_child: "POL-23",
      dispatch_boundary: { dispatch_epoch: 1, continue_epoch: 0, last_dispatched_child: "POL-23" },
    };
    const stateFile = writeState(testDir, state);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() => runLoopContinue({ stateFile, repoRoot: testDir })).toThrow("process.exit called");
    expect(errorSpy.mock.calls.some((args) => String(args[0]).includes("not a valid git hash"))).toBe(true);

    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("fails continue when result file has no validation and packet has no validation_waiver", () => {
    const clusterDir = join(testDir, ".polaris", "clusters", "POL-5");
    const resultFile = join(clusterDir, "results", "POL-23-sealed.json");
    const packetFile = join(clusterDir, "packets", "POL-23.json");
    mkdirSync(join(clusterDir, "results"), { recursive: true });
    mkdirSync(join(clusterDir, "packets"), { recursive: true });
    writeFileSync(
      resultFile,
      JSON.stringify({
        child_id: "POL-23",
        status: "done",
        commit: "abc1234",
        // no validation field
      }),
    );
    writeFileSync(packetFile, JSON.stringify({ instructions: {} }));
    const state = {
      schema_version: "1.0",
      run_id: "pol-5-session-1",
      cluster_id: "POL-5",
      active_child: "POL-23",
      completed_children: [],
      open_children: ["POL-23", "POL-24"],
      open_children_meta: {
        "POL-23": {
          result_file: resultFile,
          dispatch_record: { packet_path: packetFile, expected_result_path: resultFile },
        },
      },
      step_cursor: "dispatch",
      context_budget: { children_completed: 0, max_children_per_session: 3 },
      status: "running",
      next_open_child: "POL-23",
      dispatch_boundary: { dispatch_epoch: 1, continue_epoch: 0, last_dispatched_child: "POL-23" },
    };
    const stateFile = writeState(testDir, state);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() => runLoopContinue({ stateFile, repoRoot: testDir })).toThrow("process.exit called");
    expect(errorSpy.mock.calls.some((args) => String(args[0]).includes("no passing validation evidence"))).toBe(true);

    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("succeeds continue when result file has no validation but packet has validation_waiver", () => {
    const clusterDir = join(testDir, ".polaris", "clusters", "POL-5");
    const resultFile = join(clusterDir, "results", "POL-23-sealed.json");
    const packetFile = join(clusterDir, "packets", "POL-23.json");
    mkdirSync(join(clusterDir, "results"), { recursive: true });
    mkdirSync(join(clusterDir, "packets"), { recursive: true });
    writeFileSync(
      resultFile,
      JSON.stringify({
        child_id: "POL-23",
        status: "done",
        commit: "abc1234",
        // no validation field
      }),
    );
    writeFileSync(packetFile, JSON.stringify({ instructions: { validation_waiver: "docs-only change" } }));
    writeFileSync(
      join(clusterDir, "cluster-state.json"),
      JSON.stringify({
        schema_version: "1.0",
        cluster_id: "POL-5",
        state_generation: 1,
        child_states: [],
        claim_metadata: {},
        packet_pointers: {},
        result_pointers: {},
        validation_results: {},
        commits: {},
        tracker_mutations: {},
        blockers: [],
      }),
    );
    const state = {
      schema_version: "1.0",
      run_id: "pol-5-session-1",
      cluster_id: "POL-5",
      active_child: "POL-23",
      completed_children: [],
      open_children: ["POL-23", "POL-24"],
      open_children_meta: {
        "POL-23": {
          result_file: resultFile,
          dispatch_record: { packet_path: packetFile, expected_result_path: resultFile },
        },
      },
      step_cursor: "dispatch",
      context_budget: { children_completed: 0, max_children_per_session: 3 },
      status: "running",
      next_open_child: "POL-23",
      dispatch_boundary: { dispatch_epoch: 1, continue_epoch: 0, last_dispatched_child: "POL-23" },
    };
    const stateFile = writeState(testDir, state);
    const origLog = console.log;
    console.log = () => {};
    try {
      runLoopContinue({ stateFile, repoRoot: testDir });
    } finally {
      console.log = origLog;
    }

    const updated = readState(stateFile);
    expect(updated.completed_children).toContain("POL-23");
    expect(updated.completed_children_results?.["POL-23"]?.validation).toBe("skipped");
  });
});
